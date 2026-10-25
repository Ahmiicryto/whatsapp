import zlib from "node:zlib";
import PDFDocument from "pdfkit";
import { one, many, query } from "../db/pool.js";
import { requestJson } from "../lib/http.js";
import * as wa from "../whatsapp/cloudApi.js";
import { defaultTemplates, toMetaDefinition, validateTemplate } from "../whatsapp/templates.js";
import { badRequest } from "../lib/errors.js";
import { config } from "../config.js";

// ---------- sample media for template header examples ----------
function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Solid colour PNG (used as an example image when no product image is available). */
export function samplePng(w = 800, h = 418, rgb = [22, 163, 74]) {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function samplePdf() {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4" });
    const parts = [];
    doc.on("data", (c) => parts.push(c));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    doc.fontSize(20).text("Daily report (sample)");
    doc.end();
  });
}

async function headerExample(store, tpl) {
  const format = tpl.header?.format;
  if (format === "DOCUMENT") return { buffer: await samplePdf(), mime: "application/pdf" };
  if (format === "IMAGE") {
    const url = tpl.header.url || store.settings.defaultProductImage || store.logoUrl;
    if (url) {
      try {
        const res = await requestJson(url, { raw: true });
        const mime = res.headers.get("content-type") || "";
        if (res.ok && /image\/(jpeg|png)/.test(mime)) return { buffer: Buffer.from(await res.arrayBuffer()), mime: mime.split(";")[0] };
      } catch {
        /* fall back to generated image */
      }
    }
    return { buffer: samplePng(), mime: "image/png" };
  }
  if (format === "VIDEO") throw badRequest("Video header examples must be uploaded in Meta Business Manager");
  return null;
}

// ---------- operations ----------

export async function submitTemplate(store, templateId) {
  if (!store.wa?.wabaId) throw badRequest("Link a WhatsApp number with its WhatsApp Business Account ID first");
  const tpl = await one(`SELECT * FROM templates WHERE id=$1 AND store_id=$2`, [templateId, store.id]);
  if (!tpl) throw badRequest("Template not found");
  const problems = validateTemplate(tpl);
  if (problems.length) throw badRequest("Template is not valid", problems);
  let headerHandle;
  const example = await headerExample(store, tpl);
  if (example) headerHandle = await wa.uploadHeaderExample(store.wa, example.buffer, example.mime);
  const res = await wa.createTemplate(store.wa, toMetaDefinition(tpl, { headerHandle }));
  return one(
    `UPDATE templates SET meta_template_id=$2, status=$3, rejection_reason=NULL, category=COALESCE($4, category), updated_at=now()
      WHERE id=$1 RETURNING *`,
    [tpl.id, res.id, res.status || "PENDING", res.category || null]
  );
}

/** Pulls statuses from Meta and imports templates created directly in Meta as "custom". */
export async function syncTemplates(store) {
  if (!store.wa?.wabaId) throw badRequest("No WhatsApp Business Account linked");
  const remote = await wa.listTemplates(store.wa);
  let updated = 0;
  let imported = 0;
  for (const r of remote) {
    const row = await one(
      `UPDATE templates SET status=$4, meta_template_id=$5, rejection_reason=$6, updated_at=now()
        WHERE store_id=$1 AND name=$2 AND language=$3 RETURNING id`,
      [store.id, r.name, r.language, r.status, r.id, r.rejected_reason && r.rejected_reason !== "NONE" ? r.rejected_reason : null]
    );
    if (row) {
      updated++;
      continue;
    }
    if (r.status !== "APPROVED") continue;
    const full = await requestJson(
      `https://graph.facebook.com/${config.meta.graphVersion}/${r.id}?fields=components`,
      { headers: { Authorization: `Bearer ${store.wa.token}` } }
    );
    const comps = full.json?.components || [];
    const header = comps.find((c) => c.type === "HEADER");
    const body = comps.find((c) => c.type === "BODY")?.text || "";
    const footer = comps.find((c) => c.type === "FOOTER")?.text || null;
    const buttons = (comps.find((c) => c.type === "BUTTONS")?.buttons || []).map((b) => ({
      type: b.type,
      text: b.text,
      url: b.url,
      phone: b.phone_number,
      action: b.type === "QUICK_REPLY" ? b.text.toUpperCase().replace(/\W+/g, "_") : undefined,
      source: b.type === "URL" && /\{\{1\}\}/.test(b.url || "") ? "link.code" : undefined,
    }));
    const varCount = new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
    await query(
      `INSERT INTO templates (store_id, kind, name, language, category, header, body, footer, buttons, variables, meta_template_id, status)
       VALUES ($1,'custom',$2,$3,$4,$5,$6,$7,$8,$9,$10,'APPROVED') ON CONFLICT DO NOTHING`,
      [
        store.id,
        r.name,
        r.language,
        r.category,
        header ? { format: header.format, text: header.text || null, source: header.format === "IMAGE" ? "campaign.image" : null } : null,
        body,
        footer,
        JSON.stringify(buttons),
        JSON.stringify(Array.from({ length: varCount }, () => "customer.first_name")),
        r.id,
      ]
    );
    imported++;
  }
  return { updated, imported, remote: remote.length };
}

/**
 * Creates the default template set for a store and submits any that Meta doesn't have yet.
 * Templates with the same name already in the WABA (e.g. shared by sister stores) are linked, not re-submitted.
 */
export async function installDefaultTemplates(store, { submit = true } = {}) {
  const language = store.settings.language || "en";
  for (const t of defaultTemplates()) {
    await query(
      `INSERT INTO templates (store_id, kind, name, language, category, header, body, buttons, variables)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (store_id, name, language) DO NOTHING`,
      [store.id, t.kind, t.name, language, t.category, t.header, t.body, JSON.stringify(t.buttons), JSON.stringify(t.variables)]
    );
  }
  if (!submit || !store.wa?.wabaId) return { submitted: [], linked: [], errors: [] };
  await syncTemplates(store);
  const pending = await many(`SELECT id, name FROM templates WHERE store_id=$1 AND status='draft' AND kind <> 'custom'`, [store.id]);
  const result = { submitted: [], errors: [] };
  for (const t of pending) {
    try {
      await submitTemplate(store, t.id);
      result.submitted.push(t.name);
    } catch (err) {
      result.errors.push({ name: t.name, error: err.message, details: err.details });
    }
  }
  return result;
}
