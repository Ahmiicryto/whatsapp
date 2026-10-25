import { Router } from "express";
import { z } from "zod";
import { one, many, query } from "../../db/pool.js";
import { ah, badRequest } from "../../lib/errors.js";
import { randomToken } from "../../lib/crypto.js";
import { config } from "../../config.js";
import { scopeStoreIds, assertRow, assertStore } from "../auth.js";
import { getStoreContext } from "../../services/stores.js";
import { submitTemplate, syncTemplates, installDefaultTemplates } from "../../services/templates.js";
import { VARIABLES, TEMPLATE_KINDS, validateTemplate, renderTemplateText } from "../../whatsapp/templates.js";
import * as wa from "../../whatsapp/cloudApi.js";
import { audit } from "../../services/audit.js";

const r = Router();

const templateSchema = z.object({
  kind: z.string().refine((k) => TEMPLATE_KINDS.includes(k), "Unknown template kind"),
  name: z.string().min(1).max(512),
  language: z.string().min(2).max(10).default("en"),
  category: z.enum(["UTILITY", "MARKETING"]),
  header: z
    .object({
      format: z.enum(["NONE", "TEXT", "IMAGE", "DOCUMENT", "VIDEO"]),
      text: z.string().max(60).optional().nullable(),
      source: z.string().optional().nullable(),
      url: z.string().url().optional().nullable().or(z.literal("")),
    })
    .nullable()
    .optional(),
  body: z.string().min(1).max(1024),
  footer: z.string().max(60).optional().nullable(),
  buttons: z
    .array(
      z.object({
        type: z.enum(["QUICK_REPLY", "URL", "PHONE_NUMBER"]),
        text: z.string().min(1).max(25),
        action: z.string().optional(),
        url: z.string().optional(),
        source: z.string().optional(),
        phone: z.string().optional(),
      })
    )
    .max(10)
    .default([]),
  variables: z.array(z.union([z.string(), z.object({ source: z.string().optional(), value: z.string().optional() })])).default([]),
});

r.get("/templates/variables", (_req, res) =>
  res.json({ variables: Object.entries(VARIABLES).map(([key, v]) => ({ key, ...v })), kinds: TEMPLATE_KINDS, linkBase: `${config.baseUrl}/r/{{1}}` })
);

r.get(
  "/templates",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    res.json(await many(`SELECT t.*, s.name AS store_name FROM templates t JOIN stores s ON s.id=t.store_id WHERE t.store_id = ANY($1) ORDER BY t.kind, t.name`, [storeIds]));
  })
);

r.post(
  "/templates/validate",
  ah(async (req, res) => {
    const t = templateSchema.parse(req.body);
    const sample = Object.fromEntries(Object.entries(VARIABLES).map(([k, v]) => [k, v.sample]));
    res.json({ problems: validateTemplate(t), preview: renderTemplateText(t, sample) });
  })
);

r.post(
  "/templates",
  ah(async (req, res) => {
    const storeId = Number(req.body.storeId);
    await assertStore(req, storeId, "admin");
    const t = templateSchema.parse(req.body);
    const name = t.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    const row = await one(
      `INSERT INTO templates (store_id, kind, name, language, category, header, body, footer, buttons, variables)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [storeId, t.kind, name, t.language, t.category, t.header?.format && t.header.format !== "NONE" ? t.header : null, t.body, t.footer || null, JSON.stringify(t.buttons), JSON.stringify(t.variables)]
    ).catch((err) => {
      if (err.code === "23505") throw badRequest("A template with this name and language already exists for the store");
      throw err;
    });
    res.json({ ...row, problems: validateTemplate(row) });
  })
);

r.put(
  "/templates/:id",
  ah(async (req, res) => {
    const tpl = await assertRow(req, "templates", req.params.id, "admin");
    const t = templateSchema.parse(req.body);
    // Editing content after approval means it must be re-approved; mappings (variables/actions) can change freely.
    const contentChanged = tpl.body !== t.body || JSON.stringify(tpl.buttons.map((b) => b.text)) !== JSON.stringify(t.buttons.map((b) => b.text));
    const status = contentChanged && tpl.status !== "draft" ? "draft" : tpl.status;
    const row = await one(
      `UPDATE templates SET kind=$2, category=$3, header=$4, body=$5, footer=$6, buttons=$7, variables=$8, status=$9, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [tpl.id, t.kind, t.category, t.header?.format && t.header.format !== "NONE" ? t.header : null, t.body, t.footer || null, JSON.stringify(t.buttons), JSON.stringify(t.variables), status]
    );
    res.json({ ...row, problems: validateTemplate(row), needsResubmit: status === "draft" && tpl.status !== "draft" });
  })
);

r.post(
  "/templates/:id/submit",
  ah(async (req, res) => {
    const tpl = await assertRow(req, "templates", req.params.id, "admin");
    const store = await getStoreContext(tpl.store_id);
    const row = await submitTemplate(store, tpl.id);
    await audit({ user: req.user, storeId: store.id, action: "template.submit", target: tpl.name });
    res.json(row);
  })
);

r.post(
  "/templates/sync",
  ah(async (req, res) => {
    await assertStore(req, req.body.storeId, "admin");
    res.json(await syncTemplates(await getStoreContext(req.body.storeId)));
  })
);

r.post(
  "/templates/install-defaults",
  ah(async (req, res) => {
    await assertStore(req, req.body.storeId, "admin");
    res.json(await installDefaultTemplates(await getStoreContext(req.body.storeId), { submit: true }));
  })
);

r.delete(
  "/templates/:id",
  ah(async (req, res) => {
    const tpl = await assertRow(req, "templates", req.params.id, "admin");
    const store = await getStoreContext(tpl.store_id);
    const sharedElsewhere = await one(
      `SELECT 1 FROM templates t JOIN stores s ON s.id=t.store_id WHERE t.name=$1 AND t.id<>$2 AND s.whatsapp_number_id=$3 LIMIT 1`,
      [tpl.name, tpl.id, store.wa?.id ?? 0]
    );
    if (req.query.remote === "1" && tpl.meta_template_id && store.wa && !sharedElsewhere) await wa.deleteTemplate(store.wa, tpl.name);
    await query(`DELETE FROM templates WHERE id=$1`, [tpl.id]);
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- media uploads (template headers, campaign images, inbox)

r.post(
  "/media",
  ah(async (req, res) => {
    const { storeId, filename, mime, data } = z
      .object({ storeId: z.number().int(), filename: z.string().max(200), mime: z.string().regex(/^(image\/(jpeg|png|webp)|application\/pdf|video\/mp4)$/), data: z.string() })
      .parse(req.body);
    await assertStore(req, storeId, "agent");
    const buf = Buffer.from(data, "base64");
    if (buf.length > 5 * 1024 * 1024) throw badRequest("Max file size is 5 MB");
    const token = randomToken(18);
    await query(`INSERT INTO media_files (store_id, token, filename, mime, data) VALUES ($1,$2,$3,$4,$5)`, [storeId, token, filename, mime, buf]);
    res.json({ url: `${config.baseUrl}/media/f/${token}/${encodeURIComponent(filename)}` });
  })
);

export default r;
