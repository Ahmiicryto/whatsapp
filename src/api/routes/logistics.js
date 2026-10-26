/** Couriers, shipments & COD, fraud protection, advance payments and profit. */
import { Router } from "express";
import { z } from "zod";
import { one, many, query } from "../../db/pool.js";
import { ah, badRequest, forbidden } from "../../lib/errors.js";
import { normalizePhone } from "../../lib/phone.js";
import { config } from "../../config.js";
import { assertStore, assertRow, scopeStoreIds, accessibleStoreIds } from "../auth.js";
import { audit } from "../../services/audit.js";
import { getStoreContext } from "../../services/stores.js";
import { PROVIDERS, providerList, splitFields, loadCourier, encryptCreds, normalizeStatus, STATUSES } from "../../couriers/index.js";
import { bookShipment, syncShipment, applyShipmentStatus, settleShipments, importShipmentCsv, parseCsv } from "../../services/shipments.js";
import { phoneReputation, blockPhone, listBlocklist, unblock, requestAdvance, markAdvancePaid } from "../../services/fraud.js";
import { computeProfit } from "../../services/profit.js";
import { fillOrderItemCosts } from "../../services/products.js";
import { setOrderStatus, queueTags } from "../../services/orders.js";

const r = Router();

// ---------------------------------------------------------------- couriers

r.get("/couriers/providers", (_req, res) => res.json(providerList()));

function publicCourier(row) {
  const c = loadCourier(row);
  const fields = {};
  for (const f of c.provider?.fields || []) {
    const v = f.setting ? c.settings[f.key] : c.creds[f.key];
    fields[f.key] = f.secret ? (v ? "••••••" : "") : v ?? "";
  }
  return { id: row.id, provider: row.provider, name: row.name, is_default: row.is_default, active: row.active, fields, baseUrl: c.settings.baseUrl || "", created_at: row.created_at };
}

r.get(
  "/stores/:id/couriers",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id);
    res.json((await many(`SELECT * FROM store_couriers WHERE store_id=$1 ORDER BY is_default DESC, id`, [store.id])).map(publicCourier));
  })
);

const courierSchema = z.object({
  provider: z.enum(Object.keys(PROVIDERS)),
  name: z.string().min(1).max(60).optional(),
  fields: z.record(z.string()).default({}),
  baseUrl: z.string().optional(),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
});

async function saveDefault(storeId, courierId, isDefault) {
  if (isDefault) await query(`UPDATE store_couriers SET is_default = (id = $2) WHERE store_id=$1`, [storeId, courierId]);
  else {
    const has = await one(`SELECT 1 FROM store_couriers WHERE store_id=$1 AND is_default`, [storeId]);
    if (!has) await query(`UPDATE store_couriers SET is_default=true WHERE id=$1`, [courierId]);
  }
}

r.post(
  "/stores/:id/couriers",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    const b = courierSchema.parse(req.body);
    const p = PROVIDERS[b.provider];
    const { creds, settings } = splitFields(b.provider, { ...b.fields, baseUrl: b.baseUrl });
    const missing = p.fields.filter((f) => f.required && !(f.setting ? settings[f.key] : creds[f.key])).map((f) => f.label);
    if (missing.length) throw badRequest(`Please fill in: ${missing.join(", ")}`);
    const row = await one(
      `INSERT INTO store_couriers (store_id, provider, name, credentials_enc, settings, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [store.id, b.provider, b.name || p.name, encryptCreds(creds), settings, b.active]
    );
    await saveDefault(store.id, row.id, b.isDefault);
    await audit({ user: req.user, accountId: store.account_id, storeId: store.id, action: "courier.add", target: b.provider });
    res.json(publicCourier(await one(`SELECT * FROM store_couriers WHERE id=$1`, [row.id])));
  })
);

r.put(
  "/stores/:id/couriers/:cid",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    const row = await one(`SELECT * FROM store_couriers WHERE id=$1 AND store_id=$2`, [req.params.cid, store.id]);
    if (!row) throw badRequest("Courier not found");
    const b = courierSchema.partial().parse(req.body);
    const c = loadCourier(row);
    const { creds, settings } = splitFields(row.provider, { ...(b.fields || {}), baseUrl: b.baseUrl }, c);
    await query(`UPDATE store_couriers SET name=COALESCE($2,name), credentials_enc=$3, settings=$4, active=COALESCE($5,active), updated_at=now() WHERE id=$1`, [row.id, b.name || null, encryptCreds(creds), settings, b.active ?? null]);
    if (b.isDefault !== undefined) await saveDefault(store.id, row.id, b.isDefault);
    res.json(publicCourier(await one(`SELECT * FROM store_couriers WHERE id=$1`, [row.id])));
  })
);

r.delete(
  "/stores/:id/couriers/:cid",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    await query(`UPDATE store_couriers SET active=false, is_default=false WHERE id=$1 AND store_id=$2`, [req.params.cid, store.id]);
    res.json({ ok: true });
  })
);

r.post(
  "/stores/:id/couriers/:cid/test",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    const row = await one(`SELECT * FROM store_couriers WHERE id=$1 AND store_id=$2`, [req.params.cid, store.id]);
    if (!row) throw badRequest("Courier not found");
    const c = loadCourier(row);
    if (!c.provider.test) return res.json({ ok: true, note: "This courier has no connection test. Book a test parcel to check it." });
    try {
      res.json(await c.provider.test(c));
    } catch (err) {
      throw badRequest(err.message);
    }
  })
);

// ---------------------------------------------------------------- shipments

const TABS = {
  to_book: null,
  active: `sh.status IN ('booked','in_transit','out_for_delivery')`,
  problems: `sh.status IN ('attempted','refused','returning')`,
  delivered: `sh.status = 'delivered'`,
  returned: `sh.status = 'returned'`,
  cod: `sh.status = 'delivered' AND sh.cod_amount > 0 AND sh.cod_settled_at IS NULL`,
  settled: `sh.cod_settled_at IS NOT NULL`,
  all: "true",
};

r.get(
  "/shipments",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const tab = TABS[req.query.tab] !== undefined ? req.query.tab : "active";
    const limit = Math.min(200, Number(req.query.limit || 100));
    const q = req.query.q ? `%${String(req.query.q).slice(0, 60)}%` : null;
    if (tab === "to_book") {
      const rows = await many(
        `SELECT o.id AS order_id, o.name AS order_name, o.customer_name, o.phone_e164, o.total, o.currency, o.is_cod, o.status AS order_status, o.risk_score,
                o.advance_status, o.shipping_address->>'city' AS city, o.confirmed_at, s.name AS store_name, o.store_id
           FROM orders o JOIN stores s ON s.id=o.store_id
          WHERE o.store_id = ANY($1) AND o.status = 'confirmed' AND o.advance_status <> 'requested'
            AND NOT EXISTS (SELECT 1 FROM shipments sh WHERE sh.order_id=o.id AND sh.status <> 'cancelled')
            ${q ? "AND (o.name ILIKE $2 OR o.customer_name ILIKE $2 OR o.phone_e164 ILIKE $2)" : ""}
          ORDER BY o.confirmed_at NULLS LAST LIMIT ${limit}`,
        q ? [storeIds, q] : [storeIds]
      );
      return res.json({ rows, tab });
    }
    const rows = await many(
      `SELECT sh.*, o.name AS order_name, o.customer_name, o.phone_e164, o.currency, o.shipping_address->>'city' AS city, s.name AS store_name
         FROM shipments sh JOIN orders o ON o.id=sh.order_id JOIN stores s ON s.id=sh.store_id
        WHERE sh.store_id = ANY($1) AND ${TABS[tab]} ${q ? "AND (sh.tracking_number ILIKE $2 OR o.name ILIKE $2 OR o.customer_name ILIKE $2 OR o.phone_e164 ILIKE $2)" : ""}
        ORDER BY sh.updated_at DESC LIMIT ${limit}`,
      q ? [storeIds, q] : [storeIds]
    );
    res.json({ rows: rows.map(({ events: _e, notified: _n, ...x }) => x), tab });
  })
);

r.get(
  "/shipments/summary",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const s = await one(
      `SELECT count(*) FILTER (WHERE status IN ('booked','in_transit','out_for_delivery'))::int AS active,
              count(*) FILTER (WHERE status IN ('attempted','refused','returning'))::int AS problems,
              count(*) FILTER (WHERE status='delivered' AND booked_at > now() - interval '30 days')::int AS delivered_30d,
              count(*) FILTER (WHERE status='returned' AND booked_at > now() - interval '30 days')::int AS returned_30d,
              count(*) FILTER (WHERE status='delivered' AND cod_amount > 0 AND cod_settled_at IS NULL)::int AS cod_count,
              COALESCE(sum(cod_amount) FILTER (WHERE status='delivered' AND cod_settled_at IS NULL), 0) AS cod_due,
              COALESCE(sum(cod_amount) FILTER (WHERE status IN ('booked','in_transit','out_for_delivery','attempted')), 0) AS cod_on_road
         FROM shipments WHERE store_id = ANY($1)`,
      [storeIds]
    );
    const toBook = await one(
      `SELECT count(*)::int AS n FROM orders o WHERE o.store_id = ANY($1) AND o.status='confirmed' AND o.advance_status <> 'requested'
          AND NOT EXISTS (SELECT 1 FROM shipments sh WHERE sh.order_id=o.id AND sh.status <> 'cancelled')`,
      [storeIds]
    );
    const done = s.delivered_30d + s.returned_30d;
    res.json({ ...s, to_book: toBook.n, delivery_rate_30d: done ? Math.round((s.delivered_30d / done) * 100) : null });
  })
);

r.get(
  "/shipments/:id",
  ah(async (req, res) => {
    const sh = await assertRow(req, "shipments", req.params.id);
    res.json(sh);
  })
);

const bookSchema = z.object({ courierId: z.number().int().nullable().optional(), weightKg: z.number().positive().optional(), trackingNumber: z.string().optional(), notes: z.string().max(250).optional(), force: z.boolean().optional() });

r.post(
  "/orders/:id/book",
  ah(async (req, res) => {
    const order = await assertRow(req, "orders", req.params.id, "agent");
    const b = bookSchema.parse(req.body);
    const store = await getStoreContext(order.store_id);
    try {
      res.json(await bookShipment(store, order.id, { ...b, userId: req.user.id }));
    } catch (err) {
      throw badRequest(err.message);
    }
  })
);

r.post(
  "/shipments/book-bulk",
  ah(async (req, res) => {
    const b = z.object({ orderIds: z.array(z.number().int()).min(1).max(200), courierId: z.number().int().nullable().optional() }).parse(req.body);
    const results = [];
    for (const id of b.orderIds) {
      try {
        const order = await assertRow(req, "orders", id, "agent");
        const sh = await bookShipment(await getStoreContext(order.store_id), id, { courierId: b.courierId, userId: req.user.id });
        results.push({ orderId: id, ok: true, tracking: sh.tracking_number });
      } catch (err) {
        results.push({ orderId: id, ok: false, error: err.message });
      }
    }
    res.json({ results, booked: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length });
  })
);

r.post(
  "/shipments/:id/sync",
  ah(async (req, res) => {
    const sh = await assertRow(req, "shipments", req.params.id, "agent");
    try {
      res.json(await syncShipment(await getStoreContext(sh.store_id), sh.id));
    } catch (err) {
      throw badRequest(err.message);
    }
  })
);

r.put(
  "/shipments/:id/status",
  ah(async (req, res) => {
    const sh = await assertRow(req, "shipments", req.params.id, "agent");
    const b = z.object({ status: z.enum(STATUSES), note: z.string().max(200).optional(), trackingNumber: z.string().max(60).optional() }).parse(req.body);
    if (b.trackingNumber && b.trackingNumber !== sh.tracking_number) {
      await query(`UPDATE shipments SET tracking_number=$2 WHERE id=$1`, [sh.id, b.trackingNumber]);
      sh.tracking_number = b.trackingNumber;
    }
    const store = await getStoreContext(sh.store_id);
    const out = await applyShipmentStatus(store, sh, b.status, { raw: b.note || `Updated by ${req.user.email}`, source: "manual" });
    await audit({ user: req.user, accountId: store.accountId, storeId: store.id, action: "shipment.status", target: String(sh.id), details: { status: b.status } });
    res.json(out);
  })
);

r.post(
  "/shipments/settle",
  ah(async (req, res) => {
    const b = z.object({ ids: z.array(z.number().int()).min(1), ref: z.string().max(100).optional() }).parse(req.body);
    const storeIds = await accessibleStoreIds(req);
    const out = await settleShipments(storeIds, b.ids, b.ref);
    await audit({ user: req.user, accountId: req.accountId, action: "cod.settle", details: { count: out.count, ref: b.ref } });
    res.json(out);
  })
);

r.post(
  "/shipments/import",
  ah(async (req, res) => {
    const b = z.object({ csv: z.string().min(5).max(3_000_000) }).parse(req.body);
    const rows = parseCsv(b.csv);
    if (!rows.length) throw badRequest("The file has no rows. The first row must be the column names (tracking, status, amount).");
    const storeIds = await accessibleStoreIds(req);
    res.json(await importShipmentCsv(storeIds, rows, getStoreContext));
  })
);

// ---------------------------------------------------------------- advance payments

r.post(
  "/orders/:id/advance/:action",
  ah(async (req, res) => {
    const order = await assertRow(req, "orders", req.params.id, "agent");
    const store = await getStoreContext(order.store_id);
    switch (req.params.action) {
      case "request": {
        const { amount } = z.object({ amount: z.number().positive().optional() }).parse(req.body);
        try {
          return res.json(await requestAdvance(store, order, { amount, userId: req.user.id }));
        } catch (err) {
          throw badRequest(err.message);
        }
      }
      case "paid":
        return res.json(await markAdvancePaid(store, order.id, { userId: req.user.id, source: `marked by ${req.user.email}` }));
      case "waive": {
        const o = await setOrderStatus(order.id, order.status, { advance_status: "waived" });
        await queueTags(store, o, { remove: ["advanceRequested"] });
        return res.json(o);
      }
      default:
        throw badRequest("Unknown action");
    }
  })
);

// ---------------------------------------------------------------- fraud protection

r.get(
  "/fraud/lookup",
  ah(async (req, res) => {
    const phone = normalizePhone(String(req.query.phone || ""), config.defaults.country);
    if (!phone) throw badRequest("Enter a valid phone number");
    res.json({ phone, ...(await phoneReputation(phone, { accountId: req.accountId })) });
  })
);

r.get(
  "/fraud/summary",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const s = await one(
      `SELECT count(*) FILTER (WHERE risk_score >= 60)::int AS high_risk,
              count(*) FILTER (WHERE 'blocked-number' = ANY(shopify_tags) OR cancel_reason='blocked number')::int AS blocked_orders,
              count(*) FILTER (WHERE status='returned')::int AS returned,
              count(*) FILTER (WHERE advance_status='paid')::int AS advance_paid,
              COALESCE(sum(advance_amount) FILTER (WHERE advance_status='paid'), 0) AS advance_collected,
              count(*)::int AS orders
         FROM orders WHERE store_id = ANY($1) AND shopify_created_at > now() - interval '30 days'`,
      [storeIds]
    );
    const risky = await many(
      `SELECT o.id, o.name, o.customer_name, o.phone_e164, o.total, o.currency, o.risk_score, o.risk_reasons, o.status, o.advance_status
         FROM orders o WHERE o.store_id = ANY($1) AND o.risk_score >= 60 AND o.shopify_created_at > now() - interval '30 days'
        ORDER BY o.shopify_created_at DESC LIMIT 30`,
      [storeIds]
    );
    const blocked = await one(`SELECT count(*)::int AS n FROM blocklist WHERE account_id=$1`, [req.accountId]);
    res.json({ ...s, blocked_numbers: blocked.n, risky });
  })
);

r.get(
  "/fraud/blocklist",
  ah(async (req, res) => res.json(await listBlocklist(req.accountId, { isSuperAdmin: req.user.isSuperAdmin })))
);

r.post(
  "/fraud/blocklist",
  ah(async (req, res) => {
    const b = z.object({ phone: z.string().min(5), reason: z.string().max(200).optional(), platform: z.boolean().optional() }).parse(req.body);
    const phone = normalizePhone(b.phone, config.defaults.country);
    if (!phone) throw badRequest("Enter a valid phone number");
    if (b.platform && !req.user.isSuperAdmin) throw forbidden("Only the super admin can block numbers for every business");
    if ((req.membership?.role === "viewer") && !req.user.isSuperAdmin) throw forbidden();
    const row = await blockPhone({ accountId: b.platform ? null : req.accountId, phone, reason: b.reason, userId: req.user.id });
    await audit({ user: req.user, accountId: req.accountId, action: "fraud.block", target: phone });
    res.json(row);
  })
);

r.delete(
  "/fraud/blocklist/:id",
  ah(async (req, res) => {
    await unblock(req.accountId, Number(req.params.id), { isSuperAdmin: req.user.isSuperAdmin });
    await audit({ user: req.user, accountId: req.accountId, action: "fraud.unblock", target: req.params.id });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- profit

r.get(
  "/profit",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));
    const to = new Date();
    const from = new Date(Date.now() - days * 86400000);
    const store = storeIds.length ? await getStoreContext(storeIds[0]) : null;
    const data = await computeProfit({ storeIds, from, to, timezone: store?.timezone || "UTC" });
    res.json({ ...data, currency: store?.currency || "USD" });
  })
);

r.get(
  "/ad-spend",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    res.json(await many(`SELECT a.*, s.name AS store_name FROM ad_spend a JOIN stores s ON s.id=a.store_id WHERE a.store_id = ANY($1) ORDER BY day DESC LIMIT 120`, [storeIds]));
  })
);

r.post(
  "/ad-spend",
  ah(async (req, res) => {
    const b = z.object({ storeId: z.number().int(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), channel: z.string().min(1).max(30).default("meta"), amount: z.number().min(0) }).parse(req.body);
    await assertStore(req, b.storeId, "admin");
    res.json(
      await one(
        `INSERT INTO ad_spend (store_id, day, channel, amount) VALUES ($1,$2,$3,$4) ON CONFLICT (store_id, day, channel) DO UPDATE SET amount=EXCLUDED.amount RETURNING *`,
        [b.storeId, b.day, b.channel.toLowerCase(), b.amount]
      )
    );
  })
);

r.post(
  "/ad-spend/import",
  ah(async (req, res) => {
    const b = z.object({ storeId: z.number().int(), csv: z.string().min(5).max(1_000_000) }).parse(req.body);
    await assertStore(req, b.storeId, "admin");
    const lines = b.csv.split(/\r?\n/).map((l) => l.split(",").map((x) => x.trim()));
    let saved = 0;
    for (const [day, a, b2] of lines) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) continue; // skips the header row
      const amount = Number(String(b2 ?? a).replace(/[^\d.]/g, ""));
      const channel = b2 !== undefined ? a || "meta" : "meta";
      if (Number.isNaN(amount)) continue;
      await query(`INSERT INTO ad_spend (store_id, day, channel, amount) VALUES ($1,$2,$3,$4) ON CONFLICT (store_id, day, channel) DO UPDATE SET amount=EXCLUDED.amount`, [b.storeId, day, channel.toLowerCase(), amount]);
      saved++;
    }
    res.json({ saved });
  })
);

r.delete(
  "/ad-spend/:id",
  ah(async (req, res) => {
    const row = await assertRow(req, "ad_spend", req.params.id, "admin");
    await query(`DELETE FROM ad_spend WHERE id=$1`, [row.id]);
    res.json({ ok: true });
  })
);

r.put(
  "/products/:id/cost",
  ah(async (req, res) => {
    const p = await assertRow(req, "products", req.params.id, "admin");
    const { cost } = z.object({ cost: z.number().min(0).nullable() }).parse(req.body);
    await query(`UPDATE products SET cost_override=$2 WHERE id=$1`, [p.id, cost]);
    await query(`UPDATE order_items SET unit_cost=NULL WHERE store_id=$1 AND product_id=$2`, [p.store_id, p.shopify_product_id]);
    await fillOrderItemCosts(p.store_id);
    res.json({ ok: true });
  })
);

export { normalizeStatus };
export default r;
