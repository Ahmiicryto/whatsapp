/**
 * Public REST API for integrations (ERP, warehouse, Zapier/Make, custom apps).
 * Auth: Authorization: Bearer wa_live_… (Developers page). JSON in, JSON out.
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z, ZodError } from "zod";
import { one, many, query } from "../db/pool.js";
import { HttpError, ah, badRequest, forbidden, notFound, unauthorized } from "../lib/errors.js";
import { sha256 } from "../lib/crypto.js";
import { normalizePhone } from "../lib/phone.js";
import { config } from "../config.js";
import { getStoreContext } from "../services/stores.js";
import { sendText, sendTemplate, upsertConversation } from "../services/messaging.js";
import { customerContext } from "../services/context.js";
import * as flow from "../services/confirmation.js";
import { getOrder } from "../services/orders.js";
import { bookShipment, publicShipment } from "../services/shipments.js";
import { phoneReputation } from "../services/fraud.js";

const r = Router();

r.use(
  rateLimit({
    windowMs: 60000,
    limit: config.isTest ? 10000 : 120,
    keyGenerator: (req) => String(req.get("authorization") || req.ip),
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    message: { error: "Too many requests: max 120 per minute" },
  })
);

r.use(
  ah(async (req, _res, next) => {
    const token = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token.startsWith("wa_live_")) throw unauthorized("Missing API token. Send Authorization: Bearer wa_live_…");
    const row = await one(`SELECT t.*, a.status AS account_status FROM api_tokens t JOIN accounts a ON a.id=t.account_id WHERE t.token_hash=$1 AND t.revoked_at IS NULL`, [sha256(token)]);
    if (!row) throw unauthorized("Invalid or revoked API token");
    if (row.account_status !== "active") throw forbidden("Account suspended");
    req.apiToken = row;
    req.accountId = row.account_id;
    if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60000) await query(`UPDATE api_tokens SET last_used_at=now() WHERE id=$1`, [row.id]);
    next();
  })
);

const canWrite = (req) => {
  if (!req.apiToken.scopes.includes("write")) throw forbidden("This token is read-only");
};

async function storeIdsOf(req) {
  const rows = await many(`SELECT id FROM stores WHERE account_id=$1`, [req.accountId]);
  const ids = rows.map((x) => x.id);
  if (req.query.store_id) {
    const id = Number(req.query.store_id);
    if (!ids.includes(id)) throw forbidden("Store not in this account");
    return [id];
  }
  return ids;
}

async function ownOrder(req, id) {
  const o = await getOrder(Number(id));
  const s = o && (await one(`SELECT account_id FROM stores WHERE id=$1`, [o.store_id]));
  if (!o || s.account_id !== req.accountId) throw notFound("Order not found");
  return o;
}

const page = (req) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const p = Math.max(1, Number(req.query.page || 1));
  return { limit, offset: (p - 1) * limit, page: p };
};

const ORDER_FIELDS = `o.id, o.store_id, o.shopify_order_id, o.name, o.status, o.customer_name, o.phone_e164 AS phone, o.email, o.total, o.currency, o.is_cod,
  o.address_text AS address, o.shipping_address->>'city' AS city, o.address_status, o.risk_score, o.advance_status, o.advance_amount, o.shopify_tags AS tags,
  o.confirmed_at, o.cancelled_at, o.shopify_created_at AS created_at`;

r.get("/", (_req, res) => res.json({ ok: true, docs: `${config.baseUrl}/developers` }));

r.get(
  "/stores",
  ah(async (req, res) => {
    res.json({ data: await many(`SELECT id, name, shopify_domain, currency, timezone, status FROM stores WHERE account_id=$1 ORDER BY id`, [req.accountId]) });
  })
);

r.get(
  "/orders",
  ah(async (req, res) => {
    const ids = await storeIdsOf(req);
    const { limit, offset, page: p } = page(req);
    const params = [ids];
    const where = ["o.store_id = ANY($1)"];
    if (req.query.status) {
      params.push(String(req.query.status).split(","));
      where.push(`o.status = ANY($${params.length})`);
    }
    if (req.query.since) {
      params.push(new Date(String(req.query.since)));
      where.push(`o.updated_at >= $${params.length}`);
    }
    if (req.query.phone) {
      params.push(normalizePhone(String(req.query.phone), config.defaults.country) || "-");
      where.push(`o.phone_e164 = $${params.length}`);
    }
    const rows = await many(`SELECT ${ORDER_FIELDS} FROM orders o WHERE ${where.join(" AND ")} ORDER BY o.shopify_created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
    res.json({ data: rows, page: p, limit });
  })
);

r.get(
  "/orders/:id",
  ah(async (req, res) => {
    const o = await ownOrder(req, req.params.id);
    const [row, items, shipments] = await Promise.all([
      one(`SELECT ${ORDER_FIELDS} FROM orders o WHERE o.id=$1`, [o.id]),
      many(`SELECT title, variant_title, sku, quantity, price, image_url, product_id, variant_id FROM order_items WHERE order_id=$1 ORDER BY id`, [o.id]),
      many(`SELECT * FROM shipments WHERE order_id=$1 ORDER BY id DESC`, [o.id]),
    ]);
    res.json({ data: { ...row, items, shipments: shipments.map((s) => publicShipment(s, o)) } });
  })
);

r.post(
  "/orders/:id/:action(confirm|cancel|book)",
  ah(async (req, res) => {
    canWrite(req);
    const o = await ownOrder(req, req.params.id);
    const store = await getStoreContext(o.store_id);
    if (req.params.action === "confirm") return res.json({ data: await flow.confirmOrder(store, o, null, { source: "api" }) });
    if (req.params.action === "cancel") {
      const conv = o.phone_e164 ? await upsertConversation(store.id, o.phone_e164, { customerId: o.customer_id }) : null;
      return res.json({ data: await flow.cancelByCustomer(store, o, conv, String(req.body?.reason || "api")) });
    }
    const b = z.object({ courier_id: z.number().int().optional(), weight_kg: z.number().positive().optional(), tracking_number: z.string().optional() }).parse(req.body || {});
    try {
      const sh = await bookShipment(store, o.id, { courierId: b.courier_id, weightKg: b.weight_kg, trackingNumber: b.tracking_number });
      res.json({ data: publicShipment(sh, o) });
    } catch (err) {
      throw badRequest(err.message);
    }
  })
);

r.get(
  "/shipments",
  ah(async (req, res) => {
    const ids = await storeIdsOf(req);
    const { limit, offset, page: p } = page(req);
    const params = [ids];
    let where = "sh.store_id = ANY($1)";
    if (req.query.status) {
      params.push(String(req.query.status).split(","));
      where += ` AND sh.status = ANY($2)`;
    }
    const rows = await many(`SELECT sh.*, o.name FROM shipments sh JOIN orders o ON o.id=sh.order_id WHERE ${where} ORDER BY sh.updated_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
    res.json({ data: rows.map((s) => publicShipment(s, { name: s.name })), page: p, limit });
  })
);

r.get(
  "/customers",
  ah(async (req, res) => {
    const ids = await storeIdsOf(req);
    const { limit, offset, page: p } = page(req);
    const params = [ids];
    let where = "store_id = ANY($1)";
    if (req.query.phone) {
      params.push(normalizePhone(String(req.query.phone), config.defaults.country) || "-");
      where += " AND phone_e164 = $2";
    }
    const rows = await many(
      `SELECT id, store_id, name, phone_e164 AS phone, email, city, orders_count, total_spent, rfm_segment, wa_opt_in, tags, last_order_at FROM customers WHERE ${where} ORDER BY last_order_at DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    res.json({ data: rows, page: p, limit });
  })
);

r.get(
  "/products",
  ah(async (req, res) => {
    const ids = await storeIdsOf(req);
    const { limit, offset, page: p } = page(req);
    const q = req.query.q ? `%${req.query.q}%` : null;
    const rows = await many(
      `SELECT id, store_id, shopify_product_id, title, status, image_url, price_min, price_max, currency, inventory, variants, online_url FROM products
        WHERE store_id = ANY($1) ${q ? "AND title ILIKE $2" : ""} ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`,
      q ? [ids, q] : [ids]
    );
    res.json({ data: rows, page: p, limit });
  })
);

r.get(
  "/fraud/lookup",
  ah(async (req, res) => {
    const phone = normalizePhone(String(req.query.phone || ""), config.defaults.country);
    if (!phone) throw badRequest("phone is required");
    res.json({ data: { phone, ...(await phoneReputation(phone, { accountId: req.accountId })) } });
  })
);

r.post(
  "/messages",
  ah(async (req, res) => {
    canWrite(req);
    const b = z
      .object({ store_id: z.number().int(), phone: z.string(), text: z.string().max(4096).optional(), template: z.string().optional(), variables: z.record(z.string()).optional() })
      .refine((x) => x.text || x.template, "Send text or template")
      .parse(req.body);
    const store = await getStoreContext(b.store_id);
    if (!store || store.accountId !== req.accountId) throw forbidden("Store not in this account");
    const phone = normalizePhone(b.phone, store.country || config.defaults.country);
    if (!phone) throw badRequest("Invalid phone number");
    try {
      if (b.template) {
        const tpl = await one(`SELECT * FROM templates WHERE store_id=$1 AND (name=$2 OR kind=$2) ORDER BY (status='APPROVED') DESC LIMIT 1`, [store.id, b.template]);
        if (!tpl) throw badRequest("Template not found");
        const ctx = { ...customerContext(store, { phone_e164: phone, name: b.variables?.["customer.name"] }), ...(b.variables || {}) };
        const msg = await sendTemplate(store, { template: tpl, to: phone, ctx, messageKind: "api" });
        return res.json({ data: { id: msg.id, status: msg.status } });
      }
      const msg = await sendText(store, { to: phone, body: b.text, kind: "api" });
      res.json({ data: { id: msg.id, status: msg.status } });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw badRequest(err.message);
    }
  })
);

// JSON errors for API clients
// eslint-disable-next-line no-unused-vars
r.use((err, _req, res, _next) => {
  if (err instanceof ZodError) return res.status(400).json({ error: "Invalid input", details: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  const status = err.status || 500;
  res.status(status).json({ error: status >= 500 ? "Server error" : err.message });
});

export default r;
