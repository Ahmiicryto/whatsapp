/** Reviews, back-in-stock lists, automation rules and developer settings (API tokens, webhooks). */
import { Router } from "express";
import { z } from "zod";
import { one, many, query } from "../../db/pool.js";
import { ah, badRequest, notFound } from "../../lib/errors.js";
import { config } from "../../config.js";
import { encrypt, randomToken, sha256 } from "../../lib/crypto.js";
import { requireRole, assertStore, assertRow, scopeStoreIds } from "../auth.js";
import { audit } from "../../services/audit.js";
import { listReviews } from "../../services/reviews.js";
import { TRIGGERS, CONDITION_FIELDS, STEP_TYPES } from "../../services/rules.js";
import { WEBHOOK_EVENTS, emitEvent } from "../../services/webhooksOut.js";

const r = Router();

// ---------------------------------------------------------------- reviews

r.get(
  "/reviews",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const rows = await listReviews(storeIds, { status: req.query.status || null });
    const stats = await one(
      `SELECT round(avg(rating)::numeric, 1) AS average, count(*) FILTER (WHERE rating IS NOT NULL)::int AS rated,
              count(*) FILTER (WHERE status='published')::int AS published, count(*) FILTER (WHERE status='requested')::int AS requested,
              count(*) FILTER (WHERE rating <= 2)::int AS unhappy
         FROM reviews WHERE store_id = ANY($1)`,
      [storeIds]
    );
    res.json({ rows, stats, feedUrl: storeIds.length === 1 ? `${config.baseUrl}/public/stores/${storeIds[0]}/reviews.json` : null });
  })
);

r.put(
  "/reviews/:id",
  ah(async (req, res) => {
    const row = await assertRow(req, "reviews", req.params.id, "agent");
    const b = z.object({ status: z.enum(["pending", "published", "hidden"]).optional(), body: z.string().max(2000).optional() }).parse(req.body);
    res.json(await one(`UPDATE reviews SET status=COALESCE($2,status), body=COALESCE($3,body), updated_at=now() WHERE id=$1 RETURNING *`, [row.id, b.status || null, b.body ?? null]));
  })
);

// ---------------------------------------------------------------- back in stock

r.get(
  "/products/:id/stock-alerts",
  ah(async (req, res) => {
    const p = await assertRow(req, "products", req.params.id);
    const rows = await many(`SELECT id, variant_id, phone_e164, status, created_at, sent_at FROM stock_alerts WHERE store_id=$1 AND shopify_product_id=$2 ORDER BY created_at DESC LIMIT 200`, [p.store_id, p.shopify_product_id]);
    res.json({ rows, notifyUrl: `${config.baseUrl}/notify/${p.store_id}/${p.shopify_product_id}` });
  })
);

// ---------------------------------------------------------------- automation rules

r.get("/flows/meta", (_req, res) => res.json({ triggers: TRIGGERS, fields: CONDITION_FIELDS, steps: STEP_TYPES }));

r.get(
  "/flows",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    res.json(await many(`SELECT f.*, s.name AS store_name FROM automation_rules f JOIN stores s ON s.id=f.store_id WHERE f.store_id = ANY($1) ORDER BY f.created_at DESC`, [storeIds]));
  })
);

const ruleSchema = z.object({
  storeId: z.number().int(),
  name: z.string().min(1).max(100),
  trigger: z.enum(Object.keys(TRIGGERS)),
  conditions: z.array(z.object({ field: z.enum(Object.keys(CONDITION_FIELDS)), op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "in"]), value: z.any() })).max(20).default([]),
  steps: z
    .array(z.object({ type: z.enum(Object.keys(STEP_TYPES)) }).passthrough())
    .min(1)
    .max(20),
  active: z.boolean().default(true),
});

r.post(
  "/flows",
  ah(async (req, res) => {
    const b = ruleSchema.parse(req.body);
    await assertStore(req, b.storeId, "admin");
    const row = await one(
      `INSERT INTO automation_rules (store_id, name, trigger, conditions, steps, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.storeId, b.name, b.trigger, JSON.stringify(b.conditions), JSON.stringify(b.steps), b.active]
    );
    await audit({ user: req.user, accountId: req.accountId, storeId: b.storeId, action: "flow.create", target: b.name });
    res.json(row);
  })
);

r.put(
  "/flows/:id",
  ah(async (req, res) => {
    const row = await assertRow(req, "automation_rules", req.params.id, "admin");
    const b = ruleSchema.partial().parse(req.body);
    res.json(
      await one(
        `UPDATE automation_rules SET name=COALESCE($2,name), trigger=COALESCE($3,trigger), conditions=COALESCE($4,conditions), steps=COALESCE($5,steps), active=COALESCE($6,active), updated_at=now() WHERE id=$1 RETURNING *`,
        [row.id, b.name ?? null, b.trigger ?? null, b.conditions ? JSON.stringify(b.conditions) : null, b.steps ? JSON.stringify(b.steps) : null, b.active ?? null]
      )
    );
  })
);

r.delete(
  "/flows/:id",
  ah(async (req, res) => {
    const row = await assertRow(req, "automation_rules", req.params.id, "admin");
    await query(`DELETE FROM automation_rules WHERE id=$1`, [row.id]);
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- developers: API tokens & webhooks

r.get(
  "/developers",
  requireRole("admin"),
  ah(async (req, res) => {
    const tokens = await many(`SELECT id, name, prefix, scopes, last_used_at, revoked_at, created_at FROM api_tokens WHERE account_id=$1 ORDER BY created_at DESC`, [req.accountId]);
    const webhooks = await many(`SELECT id, url, events, active, last_status, last_error, last_sent_at, created_at FROM webhook_endpoints WHERE account_id=$1 ORDER BY created_at DESC`, [req.accountId]);
    res.json({ tokens, webhooks, events: WEBHOOK_EVENTS, apiBase: `${config.baseUrl}/v1` });
  })
);

r.post(
  "/developers/tokens",
  requireRole("admin"),
  ah(async (req, res) => {
    const b = z.object({ name: z.string().min(1).max(60), scopes: z.array(z.enum(["read", "write"])).min(1).default(["read", "write"]) }).parse(req.body);
    const token = `wa_live_${randomToken(24).replace(/[^a-zA-Z0-9]/g, "")}`;
    await query(`INSERT INTO api_tokens (account_id, name, token_hash, prefix, scopes, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [req.accountId, b.name, sha256(token), token.slice(0, 12), b.scopes, req.user.id]);
    await audit({ user: req.user, accountId: req.accountId, action: "api_token.create", target: b.name });
    res.json({ token }); // shown once
  })
);

r.delete(
  "/developers/tokens/:id",
  requireRole("admin"),
  ah(async (req, res) => {
    await query(`UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND account_id=$2`, [req.params.id, req.accountId]);
    res.json({ ok: true });
  })
);

r.post(
  "/developers/webhooks",
  requireRole("admin"),
  ah(async (req, res) => {
    const b = z.object({ url: z.string().url().refine((u) => u.startsWith("https://") || !config.baseUrl.startsWith("https://"), "Use an https:// URL"), events: z.array(z.string()).min(1) }).parse(req.body);
    const bad = b.events.filter((e) => e !== "*" && !WEBHOOK_EVENTS.includes(e));
    if (bad.length) throw badRequest(`Unknown events: ${bad.join(", ")}`);
    const secret = `whsec_${randomToken(24).replace(/[^a-zA-Z0-9]/g, "")}`;
    const row = await one(`INSERT INTO webhook_endpoints (account_id, url, secret_enc, events) VALUES ($1,$2,$3,$4) RETURNING id, url, events, active`, [req.accountId, b.url, encrypt(secret), b.events]);
    res.json({ ...row, secret }); // shown once
  })
);

r.post(
  "/developers/webhooks/:id/test",
  requireRole("admin"),
  ah(async (req, res) => {
    const ep = await one(`SELECT id FROM webhook_endpoints WHERE id=$1 AND account_id=$2`, [req.params.id, req.accountId]);
    if (!ep) throw notFound();
    await emitEvent({ accountId: req.accountId, event: "notification.created", data: { test: true, title: "Test webhook from WA Commerce", at: new Date().toISOString() } });
    res.json({ ok: true });
  })
);

r.delete(
  "/developers/webhooks/:id",
  requireRole("admin"),
  ah(async (req, res) => {
    await query(`DELETE FROM webhook_endpoints WHERE id=$1 AND account_id=$2`, [req.params.id, req.accountId]);
    res.json({ ok: true });
  })
);

export default r;
