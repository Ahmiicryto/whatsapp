import { Router } from "express";
import { z } from "zod";
import { one, many, query } from "../../db/pool.js";
import { ah, badRequest } from "../../lib/errors.js";
import { scopeStoreIds, assertRow, assertStore } from "../auth.js";
import { getStoreContext } from "../../services/stores.js";
import { previewSegment, campaignStats, SEGMENT_FIELDS } from "../../services/marketing.js";
import { sendTemplate } from "../../services/messaging.js";
import { customerContext } from "../../services/context.js";
import { normalizePhone } from "../../lib/phone.js";
import { enqueue, cancelJobs } from "../../queue/queue.js";
import { audit } from "../../services/audit.js";
import { writeCopy } from "../../ai/features.js";

const r = Router();

// ---------------------------------------------------------------- customers

r.get(
  "/customers",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const params = [storeIds];
    const where = ["c.store_id = ANY($1)"];
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where.push(`(c.name ILIKE $${params.length} OR c.phone_e164 ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.city ILIKE $${params.length})`);
    }
    if (req.query.optIn === "1") where.push("c.wa_opt_in AND c.opted_out_at IS NULL");
    if (req.query.optIn === "0") where.push("(NOT c.wa_opt_in OR c.opted_out_at IS NOT NULL)");
    if (req.query.rfm) {
      params.push(req.query.rfm);
      where.push(`c.rfm_segment = $${params.length}`);
    }
    const limit = Math.min(200, Number(req.query.limit || 50));
    const offset = (Math.max(1, Number(req.query.page || 1)) - 1) * limit;
    const rows = await many(
      `SELECT c.*, s.name AS store_name, s.currency FROM customers c JOIN stores s ON s.id=c.store_id
        WHERE ${where.join(" AND ")} ORDER BY c.last_order_at DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const total = await one(`SELECT count(*) AS n FROM customers c WHERE ${where.join(" AND ")}`, params);
    const rfm = await many(`SELECT rfm_segment, count(*) AS n FROM customers WHERE store_id = ANY($1) AND rfm_segment IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, [storeIds]);
    res.json({ rows, total: total.n, rfm });
  })
);

r.get(
  "/customers/:id",
  ah(async (req, res) => {
    const c = await assertRow(req, "customers", req.params.id);
    const orders = await many(`SELECT id, name, status, total, currency, shopify_created_at FROM orders WHERE customer_id=$1 ORDER BY shopify_created_at DESC LIMIT 50`, [c.id]);
    const conversation = c.phone_e164 ? await one(`SELECT id FROM conversations WHERE store_id=$1 AND phone_e164=$2`, [c.store_id, c.phone_e164]) : null;
    res.json({ customer: c, orders, conversationId: conversation?.id || null });
  })
);

r.patch(
  "/customers/:id",
  ah(async (req, res) => {
    const c = await assertRow(req, "customers", req.params.id, "agent");
    const { wa_opt_in } = z.object({ wa_opt_in: z.boolean() }).parse(req.body);
    const row = await one(
      wa_opt_in
        ? `UPDATE customers SET wa_opt_in=true, opt_in_source='manual', opt_in_at=now(), opted_out_at=NULL WHERE id=$1 RETURNING *`
        : `UPDATE customers SET wa_opt_in=false, opted_out_at=now() WHERE id=$1 RETURNING *`,
      [c.id]
    );
    await audit({ user: req.user, storeId: c.store_id, action: wa_opt_in ? "customer.opt_in" : "customer.opt_out", target: String(c.id) });
    res.json(row);
  })
);

r.post(
  "/customers/import",
  ah(async (req, res) => {
    const { storeId, csv, consent } = z.object({ storeId: z.number().int(), csv: z.string().max(5_000_000), consent: z.boolean() }).parse(req.body);
    const store = await assertStore(req, storeId, "admin");
    if (!consent) throw badRequest("You must confirm these customers agreed to receive WhatsApp messages");
    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    const header = lines.shift().toLowerCase().split(",").map((h) => h.trim());
    const idx = (n) => header.indexOf(n);
    if (idx("phone") < 0) throw badRequest("CSV needs a 'phone' column (optional: name, email, city, tags)");
    let imported = 0;
    let skipped = 0;
    for (const line of lines) {
      const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      const phone = normalizePhone(cols[idx("phone")], store.country);
      if (!phone) {
        skipped++;
        continue;
      }
      const name = idx("name") >= 0 ? cols[idx("name")] : null;
      const existing = await one(`SELECT id FROM customers WHERE store_id=$1 AND phone_e164=$2`, [store.id, phone]);
      if (existing) {
        await query(`UPDATE customers SET wa_opt_in=true, opt_in_source='import', opt_in_at=now() WHERE id=$1 AND opted_out_at IS NULL`, [existing.id]);
      } else {
        await query(
          `INSERT INTO customers (store_id, name, first_name, phone_e164, email, city, tags, wa_opt_in, opt_in_source, opt_in_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,true,'import',now())`,
          [
            store.id,
            name,
            name?.split(" ")[0] || null,
            phone,
            idx("email") >= 0 ? cols[idx("email")] || null : null,
            idx("city") >= 0 ? cols[idx("city")] || null : null,
            idx("tags") >= 0 ? cols[idx("tags")].split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [],
          ]
        );
      }
      imported++;
    }
    await audit({ user: req.user, accountId: store.account_id, storeId: store.id, action: "customers.import", details: { imported, skipped } });
    res.json({ imported, skipped });
  })
);

// ---------------------------------------------------------------- segments

const rulesSchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(z.object({ field: z.string(), op: z.string(), value: z.any() })).default([]),
});

r.get("/segments/fields", (_req, res) => res.json(Object.entries(SEGMENT_FIELDS).map(([k, v]) => ({ field: k, type: v.type }))));

r.get(
  "/segments",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    res.json(await many(`SELECT * FROM segments WHERE store_id = ANY($1) ORDER BY name`, [storeIds]));
  })
);

r.post(
  "/segments/preview",
  ah(async (req, res) => {
    const { storeId, rules } = z.object({ storeId: z.number().int(), rules: rulesSchema }).parse(req.body);
    await assertStore(req, storeId);
    res.json(await previewSegment(await getStoreContext(storeId), rules));
  })
);

r.post(
  "/segments",
  ah(async (req, res) => {
    const { storeId, name, rules } = z.object({ storeId: z.number().int(), name: z.string().min(1), rules: rulesSchema }).parse(req.body);
    await assertStore(req, storeId, "admin");
    res.json(await one(`INSERT INTO segments (store_id, name, rules) VALUES ($1,$2,$3) RETURNING *`, [storeId, name, rules]));
  })
);

r.put(
  "/segments/:id",
  ah(async (req, res) => {
    const seg = await assertRow(req, "segments", req.params.id, "admin");
    const { name, rules } = z.object({ name: z.string().min(1), rules: rulesSchema }).parse(req.body);
    res.json(await one(`UPDATE segments SET name=$2, rules=$3, updated_at=now() WHERE id=$1 RETURNING *`, [seg.id, name, rules]));
  })
);

r.delete(
  "/segments/:id",
  ah(async (req, res) => {
    const seg = await assertRow(req, "segments", req.params.id, "admin");
    await query(`DELETE FROM segments WHERE id=$1`, [seg.id]);
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- campaigns

const campaignSchema = z.object({
  storeId: z.number().int(),
  name: z.string().min(1),
  template_id: z.number().int().nullable(),
  template_b_id: z.number().int().nullable().optional(),
  ab_split: z.number().int().min(1).max(99).optional(),
  segment_id: z.number().int().nullable().optional(),
  variables: z.record(z.string()).optional(),
  header_media_url: z.string().url().nullable().optional().or(z.literal("")),
  link_url: z.string().url().nullable().optional().or(z.literal("")),
  discount: z.object({ percent: z.number().min(1).max(90), days: z.number().int().min(1).max(60) }).nullable().optional(),
});

r.get(
  "/campaigns",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const rows = await many(
      `SELECT c.*, s.name AS store_name, s.currency, t.name AS template_name, g.name AS segment_name,
              (SELECT count(*) FROM campaign_recipients r WHERE r.campaign_id=c.id) AS recipients,
              (SELECT count(*) FROM campaign_recipients r WHERE r.campaign_id=c.id AND r.status='sent') AS sent,
              (SELECT count(*) FROM campaign_recipients r WHERE r.campaign_id=c.id AND r.order_id IS NOT NULL) AS orders,
              (SELECT COALESCE(sum(revenue),0) FROM campaign_recipients r WHERE r.campaign_id=c.id) AS revenue
         FROM campaigns c JOIN stores s ON s.id=c.store_id LEFT JOIN templates t ON t.id=c.template_id LEFT JOIN segments g ON g.id=c.segment_id
        WHERE c.store_id = ANY($1) ORDER BY c.created_at DESC LIMIT 200`,
      [storeIds]
    );
    res.json(rows);
  })
);

r.get(
  "/campaigns/:id",
  ah(async (req, res) => {
    const c = await assertRow(req, "campaigns", req.params.id);
    const stats = await campaignStats(c.id);
    const recipients = await many(
      `SELECT r.id, r.variant, r.status, r.clicked_at, r.revenue, r.discount_code, cu.name, cu.phone_e164, m.status AS message_status
         FROM campaign_recipients r JOIN customers cu ON cu.id=r.customer_id LEFT JOIN messages m ON m.id=r.message_id
        WHERE r.campaign_id=$1 ORDER BY r.id LIMIT 200`,
      [c.id]
    );
    res.json({ campaign: c, stats, recipients });
  })
);

function campaignValues(b) {
  return [
    b.name,
    b.template_id ?? null,
    b.template_b_id ?? null,
    b.ab_split ?? 50,
    b.segment_id ?? null,
    b.variables || {},
    b.header_media_url || null,
    b.link_url || null,
    b.discount ?? null,
  ];
}

r.post(
  "/campaigns",
  ah(async (req, res) => {
    const b = campaignSchema.parse(req.body);
    await assertStore(req, b.storeId, "admin");
    res.json(
      await one(
        `INSERT INTO campaigns (store_id, name, template_id, template_b_id, ab_split, segment_id, variables, header_media_url, link_url, discount, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [b.storeId, ...campaignValues(b), req.user.id]
      )
    );
  })
);

r.put(
  "/campaigns/:id",
  ah(async (req, res) => {
    const c = await assertRow(req, "campaigns", req.params.id, "admin");
    if (!["draft", "scheduled"].includes(c.status)) throw badRequest("Only draft or scheduled campaigns can be edited");
    const b = campaignSchema.parse({ ...req.body, storeId: c.store_id });
    res.json(
      await one(
        `UPDATE campaigns SET name=$2, template_id=$3, template_b_id=$4, ab_split=$5, segment_id=$6, variables=$7, header_media_url=$8, link_url=$9,
           discount=$10, updated_at=now() WHERE id=$1 RETURNING *`,
        [c.id, ...campaignValues(b)]
      )
    );
  })
);

r.post(
  "/campaigns/:id/schedule",
  ah(async (req, res) => {
    const c = await assertRow(req, "campaigns", req.params.id, "admin");
    if (!["draft", "scheduled"].includes(c.status)) throw badRequest("Campaign already started");
    const t = await one(`SELECT status, category FROM templates WHERE id=$1`, [c.template_id]);
    if (t?.status !== "APPROVED") throw badRequest("Pick an approved template first");
    const at = req.body.at ? new Date(req.body.at) : new Date();
    if (Number.isNaN(at.getTime())) throw badRequest("Invalid date");
    const row = await one(`UPDATE campaigns SET status='scheduled', schedule_at=$2, updated_at=now() WHERE id=$1 RETURNING *`, [c.id, at]);
    if (at <= new Date()) await enqueue("campaign.dispatch", { storeId: c.store_id, campaignId: c.id }, { singletonKey: `campaign:${c.id}:dispatch` });
    await audit({ user: req.user, storeId: c.store_id, action: "campaign.schedule", target: c.name, details: { at } });
    res.json(row);
  })
);

r.post(
  "/campaigns/:id/cancel",
  ah(async (req, res) => {
    const c = await assertRow(req, "campaigns", req.params.id, "admin");
    await query(`UPDATE campaigns SET status='cancelled', updated_at=now() WHERE id=$1 AND status IN ('draft','scheduled','sending')`, [c.id]);
    await cancelJobs(`campaign:${c.id}:`);
    res.json({ ok: true });
  })
);

r.post(
  "/campaigns/:id/test",
  ah(async (req, res) => {
    const c = await assertRow(req, "campaigns", req.params.id, "admin");
    const store = await getStoreContext(c.store_id);
    const to = normalizePhone(req.body.phone, store.country);
    if (!to) throw badRequest("Enter a valid phone number");
    const tpl = await one(`SELECT * FROM templates WHERE id=$1`, [c.template_id]);
    if (tpl?.status !== "APPROVED") throw badRequest("Template is not approved yet");
    const ctx = { ...customerContext(store, { id: null, name: "Test Customer", first_name: "Test", phone_e164: to }), ...(c.variables || {}) };
    ctx["campaign.image"] = c.header_media_url || store.settings.defaultProductImage || store.logoUrl;
    ctx["link.code"] = "test";
    ctx["discount.code"] = "TEST-CODE";
    ctx["discount.percent"] = String(c.discount?.percent || 10);
    ctx["discount.days"] = String(c.discount?.days || 7);
    // test sends go to the admin's own number, so the customer opt-in check doesn't apply
    await sendTemplate(store, { template: tpl, to, ctx, messageKind: "campaign_test", skipOptInCheck: true });
    res.json({ ok: true });
  })
);

r.post(
  "/ai/copy",
  ah(async (req, res) => {
    const b = z
      .object({ storeId: z.number().int(), brief: z.string().min(3).max(1000), kind: z.enum(["campaign", "template"]).default("campaign"), language: z.string().default("English"), tone: z.string().optional() })
      .parse(req.body);
    await assertStore(req, b.storeId, "agent");
    const store = await getStoreContext(b.storeId);
    res.json(await writeCopy(store, b));
  })
);

export default r;
