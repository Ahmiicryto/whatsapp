/** Workspace-wide helpers: notifications bell, global search and the onboarding checklist. */
import { Router } from "express";
import { z } from "zod";
import { one, many } from "../../db/pool.js";
import { ah } from "../../lib/errors.js";
import { accessibleStoreIds } from "../auth.js";
import { listNotifications, markRead } from "../../services/notifications.js";

const r = Router();

async function ctxOf(req) {
  return { userId: req.user.id, accountId: req.accountId, isSuperAdmin: !!req.user.isSuperAdmin, storeIds: await accessibleStoreIds(req) };
}

r.get(
  "/notifications",
  ah(async (req, res) => {
    res.json(await listNotifications(await ctxOf(req), { limit: req.query.limit, unreadOnly: req.query.unread === "1" }));
  })
);

r.post(
  "/notifications/read",
  ah(async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.number().int()).optional() }).parse(req.body);
    await markRead(await ctxOf(req), ids);
    res.json({ ok: true });
  })
);

/** One box searches orders, customers, conversations, products, shipments and stores. */
r.get(
  "/search",
  ah(async (req, res) => {
    const q = String(req.query.q || "").trim().slice(0, 80);
    const storeIds = await accessibleStoreIds(req);
    if (q.length < 2 || !storeIds.length) return res.json({ results: [] });
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const digits = q.replace(/\D/g, "");
    const phoneLike = digits.length >= 4 ? `%${digits.slice(-10)}%` : "__none__";
    const [orders, customers, conversations, products, shipments, stores] = await Promise.all([
      many(
        `SELECT o.id, o.name, o.customer_name, o.phone_e164, o.total, o.currency, o.status, s.name AS store_name
           FROM orders o JOIN stores s ON s.id=o.store_id
          WHERE o.store_id = ANY($1) AND (o.name ILIKE $2 OR o.customer_name ILIKE $2 OR o.email ILIKE $2 OR o.phone_e164 LIKE $3 OR o.address_text ILIKE $2)
          ORDER BY o.shopify_created_at DESC LIMIT 6`,
        [storeIds, like, phoneLike]
      ),
      many(
        `SELECT c.id, c.name, c.phone_e164, c.city, c.orders_count, s.name AS store_name FROM customers c JOIN stores s ON s.id=c.store_id
          WHERE c.store_id = ANY($1) AND (c.name ILIKE $2 OR c.email ILIKE $2 OR c.phone_e164 LIKE $3)
          ORDER BY c.last_order_at DESC NULLS LAST LIMIT 5`,
        [storeIds, like, phoneLike]
      ),
      many(
        `SELECT c.id, c.name, c.phone_e164, c.last_message_preview, c.unread FROM conversations c
          WHERE c.store_id = ANY($1) AND (c.name ILIKE $2 OR c.phone_e164 LIKE $3 OR c.last_message_preview ILIKE $2)
          ORDER BY c.last_message_at DESC NULLS LAST LIMIT 5`,
        [storeIds, like, phoneLike]
      ),
      many(
        `SELECT p.id, p.title, p.image_url, p.price_min, p.currency, p.inventory FROM products p
          WHERE p.store_id = ANY($1) AND (p.title ILIKE $2 OR p.vendor ILIKE $2 OR EXISTS (SELECT 1 FROM jsonb_array_elements(p.variants) v WHERE v->>'sku' ILIKE $2))
          ORDER BY p.updated_at DESC LIMIT 5`,
        [storeIds, like]
      ),
      many(
        `SELECT sh.id, sh.order_id, sh.tracking_number, sh.courier_name, sh.status, o.name AS order_name FROM shipments sh JOIN orders o ON o.id=sh.order_id
          WHERE sh.store_id = ANY($1) AND sh.tracking_number ILIKE $2 ORDER BY sh.booked_at DESC LIMIT 4`,
        [storeIds, like]
      ),
      many(`SELECT id, name, shopify_domain FROM stores WHERE id = ANY($1) AND (name ILIKE $2 OR shopify_domain ILIKE $2) LIMIT 3`, [storeIds, like]),
    ]);
    const results = [
      ...orders.map((o) => ({ type: "order", id: o.id, title: `${o.name} · ${o.customer_name || "Customer"}`, sub: `${o.status} · ${o.store_name}`, link: `/orders/${o.id}` })),
      ...shipments.map((s) => ({ type: "shipment", id: s.id, title: `${s.tracking_number} · ${s.courier_name || "Courier"}`, sub: `${s.status} · order ${s.order_name}`, link: `/orders/${s.order_id}` })),
      ...customers.map((c) => ({ type: "customer", id: c.id, title: c.name || c.phone_e164, sub: `${c.phone_e164 || ""} · ${c.orders_count} orders · ${c.store_name}`, link: `/customers?q=${encodeURIComponent(c.phone_e164 || c.name || "")}` })),
      ...conversations.map((c) => ({ type: "chat", id: c.id, title: c.name || c.phone_e164, sub: c.last_message_preview || "", link: `/inbox/${c.id}` })),
      ...products.map((p) => ({ type: "product", id: p.id, title: p.title, sub: `${p.inventory ?? "?"} in stock`, image: p.image_url, link: `/products?q=${encodeURIComponent(p.title)}` })),
      ...stores.map((s) => ({ type: "store", id: s.id, title: s.name, sub: s.shopify_domain, link: `/stores/${s.id}` })),
    ];
    res.json({ results });
  })
);

/** Getting-started checklist shown on the dashboard and in the Help center. */
r.get(
  "/onboarding",
  ah(async (req, res) => {
    const storeIds = await accessibleStoreIds(req);
    const s = await one(
      `SELECT count(*)::int AS stores,
              count(*) FILTER (WHERE whatsapp_number_id IS NOT NULL)::int AS whatsapp,
              (SELECT count(*)::int FROM templates WHERE store_id = ANY($1) AND status='APPROVED') AS templates,
              (SELECT count(*)::int FROM store_couriers WHERE store_id = ANY($1) AND active) AS couriers,
              (SELECT count(*)::int FROM orders WHERE store_id = ANY($1) AND confirmation_sent_at IS NOT NULL) AS confirmations,
              (SELECT count(*)::int FROM products WHERE store_id = ANY($1)) AS products
         FROM stores WHERE id = ANY($1)`,
      [storeIds]
    );
    const me = await one(`SELECT phone_e164 FROM users WHERE id=$1`, [req.user.id]);
    const first = storeIds[0];
    const steps = [
      { id: "store", title: "Connect your Shopify store", done: s.stores > 0, link: "/stores" },
      { id: "whatsapp", title: "Connect a WhatsApp number", done: s.whatsapp > 0, link: first ? `/stores/${first}?tab=whatsapp` : "/stores" },
      { id: "templates", title: "Get message templates approved (or use QR connect)", done: s.templates > 0 || s.confirmations > 0, link: "/templates" },
      { id: "products", title: "Import product photos", done: s.products > 0, link: "/products" },
      { id: "courier", title: "Add a courier for automatic booking", done: s.couriers > 0, link: first ? `/stores/${first}?tab=couriers` : "/stores" },
      { id: "profile", title: "Add your WhatsApp number for daily reports", done: !!me?.phone_e164, link: "/profile" },
      { id: "first", title: "Send your first order confirmation", done: s.confirmations > 0, link: "/orders" },
    ];
    res.json({ steps, done: steps.filter((x) => x.done).length, total: steps.length });
  })
);

export default r;
