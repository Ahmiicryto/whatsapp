import { Router } from "express";
import { phoneReputation } from "../../services/fraud.js";
import { z } from "zod";
import { one, many, query } from "../../db/pool.js";
import { ah, badRequest } from "../../lib/errors.js";
import { scopeStoreIds, assertRow } from "../auth.js";
import { enqueue } from "../../queue/queue.js";
import { getStoreContext } from "../../services/stores.js";
import { audit } from "../../services/audit.js";
import * as flow from "../../services/confirmation.js";
import { applyCustomerAddress } from "../../services/address.js";
import { upsertConversation } from "../../services/messaging.js";

const r = Router();

function orderFilters(req, storeIds) {
  const params = [storeIds];
  const where = ["o.store_id = ANY($1)"];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  const q = req.query;
  if (q.status) add("o.status = ANY(?)", String(q.status).split(","));
  if (q.address) add("o.address_status = ANY(?)", String(q.address).split(","));
  if (q.payment === "cod") where.push("o.is_cod");
  if (q.payment === "prepaid") where.push("NOT o.is_cod");
  if (q.risk === "high") where.push("o.risk_score >= 60");
  if (q.attention === "1") where.push("o.needs_attention");
  if (q.from) add("o.shopify_created_at >= ?", new Date(q.from));
  if (q.to) add("o.shopify_created_at < ?", new Date(q.to));
  if (q.tag) add("? = ANY(o.shopify_tags)", String(q.tag));
  if (q.q) {
    const term = `%${String(q.q).trim()}%`;
    params.push(term);
    const n = params.length;
    where.push(`(o.name ILIKE $${n} OR o.customer_name ILIKE $${n} OR o.phone_e164 ILIKE $${n} OR o.email ILIKE $${n} OR o.address_text ILIKE $${n})`);
  }
  return { where: where.join(" AND "), params };
}

r.get(
  "/orders",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const { where, params } = orderFilters(req, storeIds);
    const limit = Math.min(200, Number(req.query.limit || 50));
    const offset = Math.max(0, (Number(req.query.page || 1) - 1) * limit);
    const rows = await many(
      `SELECT o.id, o.store_id, s.name AS store_name, o.name, o.customer_name, o.phone_e164, o.total, o.currency, o.is_cod,
              o.status, o.address_status, o.address_score, o.risk_score, o.needs_attention, o.shopify_tags, o.shopify_created_at,
              o.address_text, (SELECT image_url FROM order_items i WHERE i.order_id=o.id AND image_url IS NOT NULL LIMIT 1) AS image
         FROM orders o JOIN stores s ON s.id=o.store_id
        WHERE ${where} ORDER BY o.shopify_created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const total = await one(`SELECT count(*) AS n FROM orders o WHERE ${where}`, params);
    res.json({ rows, total: total.n, page: Number(req.query.page || 1), limit });
  })
);

r.get(
  "/orders/export.csv",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const { where, params } = orderFilters(req, storeIds);
    const rows = await many(
      `SELECT o.name, s.name AS store, o.shopify_created_at, o.customer_name, o.phone_e164, o.total, o.currency,
              CASE WHEN o.is_cod THEN 'COD' ELSE 'Prepaid' END AS payment, o.status, o.address_status, o.address_score, o.risk_score,
              o.address_text, array_to_string(o.shopify_tags, ' ') AS tags
         FROM orders o JOIN stores s ON s.id=o.store_id WHERE ${where} ORDER BY o.shopify_created_at DESC LIMIT 20000`,
      params
    );
    const cols = ["name", "store", "shopify_created_at", "customer_name", "phone_e164", "total", "currency", "payment", "status", "address_status", "address_score", "risk_score", "address_text", "tags"];
    const esc = (v) => {
      const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send([cols.join(","), ...rows.map((row) => cols.map((c) => esc(row[c])).join(","))].join("\n"));
  })
);

r.get(
  "/orders/:id",
  ah(async (req, res) => {
    const order = await assertRow(req, "orders", req.params.id);
    const [items, messages, fulfillments, addressChecks, customer] = await Promise.all([
      many(`SELECT * FROM order_items WHERE order_id=$1 ORDER BY id`, [order.id]),
      many(
        `SELECT id, direction, kind, template_name, body, status, error_text, ai_generated, media, created_at FROM messages
          WHERE order_id=$1 OR (conversation_id IN (SELECT id FROM conversations WHERE store_id=$2 AND phone_e164=$3) AND created_at > $4::timestamptz - interval '1 hour')
          ORDER BY created_at`,
        [order.id, order.store_id, order.phone_e164 || "-", order.shopify_created_at]
      ),
      many(`SELECT * FROM fulfillments WHERE order_id=$1 ORDER BY created_at`, [order.id]),
      many(`SELECT * FROM address_checks WHERE order_id=$1 ORDER BY created_at DESC LIMIT 20`, [order.id]),
      order.customer_id ? one(`SELECT id, name, phone_e164, orders_count, total_spent, wa_opt_in, rfm_segment FROM customers WHERE id=$1`, [order.customer_id]) : null,
    ]);
    const store = await one(`SELECT name, shopify_domain FROM stores WHERE id=$1`, [order.store_id]);
    const conversation = order.phone_e164 ? await one(`SELECT id, last_inbound_at FROM conversations WHERE store_id=$1 AND phone_e164=$2`, [order.store_id, order.phone_e164]) : null;
    const shipments = await many(`SELECT * FROM shipments WHERE order_id=$1 ORDER BY id DESC`, [order.id]);
    const reputation = order.phone_e164 ? await phoneReputation(order.phone_e164, { excludeOrderId: order.id, accountId: req.accountId }) : null;
    res.json({
      shipments,
      reputation,
      order,
      items,
      messages,
      fulfillments,
      addressChecks,
      customer,
      conversation,
      store,
      shopifyAdminUrl: `https://${store.shopify_domain}/admin/orders/${order.shopify_order_id}`,
    });
  })
);

const addressSchema = z.object({
  address1: z.string().min(3),
  address2: z.string().optional().nullable(),
  city: z.string().min(1),
  province: z.string().optional().nullable(),
  zip: z.string().optional().nullable(),
  countryCode: z.string().optional().nullable(),
  lat: z.number().optional().nullable(),
  lng: z.number().optional().nullable(),
});

r.post(
  "/orders/:id/actions",
  ah(async (req, res) => {
    const action = String(req.body.action || "");
    const order = await assertRow(req, "orders", req.params.id, ["resolve_attention"].includes(action) ? "agent" : "agent");
    const store = await getStoreContext(order.store_id);
    let result = { ok: true };
    switch (action) {
      case "resend_confirmation":
        if (!order.phone_e164) throw badRequest("Order has no valid phone number");
        await enqueue("confirmation.send", { storeId: store.id, orderId: order.id, force: true }, { singletonKey: `order:${order.id}:confirm:send` });
        result.queued = true;
        break;
      case "process":
        await enqueue("order.process", { storeId: store.id, orderId: order.id }, { singletonKey: `order:${order.id}:process` });
        result.queued = true;
        break;
      case "mark_confirmed":
        await flow.confirmOrder(store, order, null, { source: "manual" });
        break;
      case "mark_cancelled":
        await flow.cancelByCustomer(store, order, null, String(req.body.reason || "manual"));
        break;
      case "check_address":
        await enqueue("address.check", { storeId: store.id, orderId: order.id });
        result.queued = true;
        break;
      case "request_address":
        if (!order.phone_e164) throw badRequest("Order has no valid phone number");
        await enqueue("address.request", { storeId: store.id, orderId: order.id });
        result.queued = true;
        break;
      case "update_address": {
        const addr = addressSchema.parse(req.body.address || {});
        await applyCustomerAddress(store, order, addr, { source: "manual" });
        break;
      }
      case "send_tracking": {
        const f = await one(`SELECT * FROM fulfillments WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1`, [order.id]);
        if (!f) throw badRequest("This order has no fulfillment yet");
        await query(`UPDATE fulfillments SET notified = notified - 'shipped' WHERE id=$1`, [f.id]);
        await enqueue("tracking.notify", { storeId: store.id, fulfillmentId: f.id, event: "shipped" });
        result.queued = true;
        break;
      }
      case "send_product_images": {
        const conv = await upsertConversation(store.id, order.phone_e164, { customerId: order.customer_id });
        await flow.sendProductImages(store, order, conv);
        break;
      }
      case "resolve_attention":
        await query(`UPDATE orders SET needs_attention=false WHERE id=$1`, [order.id]);
        break;
      default:
        throw badRequest("Unknown action");
    }
    await audit({ user: req.user, accountId: store.accountId, storeId: store.id, action: `order.${action}`, target: order.name });
    res.json(result);
  })
);

export default r;
