import { one, many, query, tx } from "../db/pool.js";
import { normalizePhone } from "../lib/phone.js";
import { formatAddress } from "../lib/format.js";
import { enqueue, cancelJobs } from "../queue/queue.js";
import { logger } from "../logger.js";

function pickPhone(n, country) {
  for (const raw of n.phoneCandidates || [n.phoneRaw]) {
    const p = normalizePhone(raw, n.shippingAddress?.countryCode || country);
    if (p) return p;
  }
  return null;
}

export async function upsertCustomer(client, storeId, c) {
  // Match by Shopify id, else by phone (guest checkouts), else create.
  let row = null;
  if (c.shopifyId) row = (await client.query(`SELECT * FROM customers WHERE store_id=$1 AND shopify_customer_id=$2`, [storeId, c.shopifyId])).rows[0];
  if (!row && c.phone) row = (await client.query(`SELECT * FROM customers WHERE store_id=$1 AND phone_e164=$2 ORDER BY id LIMIT 1`, [storeId, c.phone])).rows[0];
  if (!row && c.existingId) row = (await client.query(`SELECT * FROM customers WHERE id=$1`, [c.existingId])).rows[0];
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.name || null;
  if (row) {
    const { rows } = await client.query(
      `UPDATE customers SET
         shopify_customer_id = COALESCE(shopify_customer_id, $2),
         name = COALESCE($3, name), first_name = COALESCE($4, first_name),
         phone_e164 = COALESCE($5, phone_e164), email = COALESCE($6, email),
         city = COALESCE($7, city), country = COALESCE($8, country),
         tags = CASE WHEN $9::text[] IS NULL THEN tags ELSE $9 END,
         wa_opt_in = CASE WHEN $10 AND opted_out_at IS NULL THEN true ELSE wa_opt_in END,
         opt_in_source = CASE WHEN $10 AND opted_out_at IS NULL AND NOT wa_opt_in THEN 'shopify' ELSE opt_in_source END,
         opt_in_at = CASE WHEN $10 AND opted_out_at IS NULL AND NOT wa_opt_in THEN now() ELSE opt_in_at END,
         updated_at = now()
       WHERE id=$1 RETURNING *`,
      [row.id, c.shopifyId ?? null, name, c.firstName ?? null, c.phone ?? null, c.email ?? null, c.city ?? null, c.country ?? null, c.tags ?? null, !!c.acceptsMarketing]
    );
    return rows[0];
  }
  const { rows } = await client.query(
    `INSERT INTO customers (store_id, shopify_customer_id, name, first_name, phone_e164, email, city, country, tags,
                            wa_opt_in, opt_in_source, opt_in_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (store_id, shopify_customer_id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [
      storeId,
      c.shopifyId ?? null,
      name,
      c.firstName ?? null,
      c.phone ?? null,
      c.email ?? null,
      c.city ?? null,
      c.country ?? null,
      c.tags || [],
      !!c.acceptsMarketing,
      c.acceptsMarketing ? "shopify" : null,
      c.acceptsMarketing ? new Date() : null,
    ]
  );
  return rows[0];
}

export async function refreshCustomerStats(customerId) {
  if (!customerId) return;
  await query(
    `UPDATE customers c SET
       orders_count = s.cnt, total_spent = s.spent, first_order_at = s.first_at, last_order_at = s.last_at, updated_at = now()
     FROM (SELECT count(*) cnt, COALESCE(sum(total) FILTER (WHERE status NOT IN ('cancelled','cancelled_by_customer')),0) spent,
                  min(shopify_created_at) first_at, max(shopify_created_at) last_at
             FROM orders WHERE customer_id=$1) s
     WHERE c.id=$1`,
    [customerId]
  );
}

/**
 * Upserts a normalized Shopify order (+ customer + line items).
 * Returns { order, isNew, addressChanged }.
 */
export async function ingestOrder(store, n, { source = "webhook" } = {}) {
  const phone = pickPhone(n, store.country);
  const addr = n.shippingAddress;
  const addressText = formatAddress(addr);
  const firstName = addr?.firstName || n.customer?.firstName || null;
  const customerName = addr?.name || [addr?.firstName, addr?.lastName].filter(Boolean).join(" ") || [n.customer?.firstName, n.customer?.lastName].filter(Boolean).join(" ") || null;

  const result = await tx(async (client) => {
    const existing = (await client.query(`SELECT * FROM orders WHERE store_id=$1 AND shopify_order_id=$2 FOR UPDATE`, [store.id, n.shopifyOrderId])).rows[0];
    const customer = await upsertCustomer(client, store.id, {
      existingId: existing?.customer_id,
      ...(n.customer || {}),
      firstName: n.customer?.firstName || addr?.firstName,
      lastName: n.customer?.lastName || addr?.lastName,
      phone: phone || null,
      email: n.email,
      city: addr?.city,
      country: addr?.countryCode,
      tags: n.customer?.tags,
    });

    if (!existing) {
      const { rows } = await client.query(
        `INSERT INTO orders (store_id, customer_id, shopify_order_id, name, customer_name, first_name, phone_e164, phone_raw, email,
            total, subtotal, currency, gateway, is_cod, financial_status, fulfillment_status, shipping_address, address_text,
            status, shopify_tags, discount_codes, order_status_url, checkout_token, source, cancelled_at, shopify_created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         RETURNING *`,
        [
          store.id, customer.id, n.shopifyOrderId, n.name, customerName, firstName, phone, n.phoneRaw, n.email,
          n.total, n.subtotal, n.currency || store.currency, n.gateway, n.isCod, n.financialStatus, n.fulfillmentStatus,
          addr, addressText, n.cancelledAt ? "cancelled" : "new", n.tags, n.discountCodes, n.orderStatusUrl, n.checkoutToken,
          source, n.cancelledAt, n.createdAt,
        ]
      );
      const order = rows[0];
      for (const li of n.lineItems) {
        await client.query(
          `INSERT INTO order_items (order_id, store_id, shopify_line_item_id, product_id, variant_id, title, variant_title, sku, quantity, price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [order.id, store.id, li.lineItemId, li.productId, li.variantId, li.title, li.variantTitle, li.sku, li.quantity, li.price]
        );
      }
      return { order, isNew: true, addressChanged: false };
    }

    const addressChanged = addressText !== (existing.address_text || "");
    let status = existing.status;
    if (n.cancelledAt && !["cancelled", "cancelled_by_customer"].includes(status)) status = "cancelled";
    if (!n.cancelledAt && n.fulfillmentStatus === "fulfilled" && ["new", "awaiting_reply", "confirmed", "no_response", "not_eligible", "no_phone"].includes(status)) {
      status = "fulfilled";
    }
    const { rows } = await client.query(
      `UPDATE orders SET customer_id=$2, name=$3, customer_name=COALESCE($4, customer_name), first_name=COALESCE($5, first_name),
          phone_e164=COALESCE($6, phone_e164), email=COALESCE($7, email), total=$8, subtotal=$9, financial_status=$10,
          fulfillment_status=$11, shopify_tags=$12, discount_codes=$13, cancelled_at=$14, status=$15,
          shipping_address = CASE WHEN $16 THEN $17::jsonb ELSE shipping_address END,
          address_text = CASE WHEN $16 THEN $18 ELSE address_text END,
          address_status = CASE WHEN $16 AND address_status NOT IN ('updated','awaiting_customer') THEN 'unchecked' ELSE address_status END,
          updated_at = now()
       WHERE id=$1 RETURNING *`,
      [
        existing.id, customer.id, n.name, customerName, firstName, phone, n.email, n.total, n.subtotal, n.financialStatus,
        n.fulfillmentStatus, n.tags, n.discountCodes, n.cancelledAt, status, addressChanged, addr, addressText,
      ]
    );
    return { order: rows[0], isNew: false, addressChanged, wasCancelled: status === "cancelled" && existing.status !== "cancelled" };
  });

  await refreshCustomerStats(result.order.customer_id);
  if (result.wasCancelled) await cancelJobs(`order:${result.order.id}:`);
  return result;
}

export async function getOrder(orderId) {
  return one(`SELECT * FROM orders WHERE id=$1`, [orderId]);
}

export async function getOrderItems(orderId) {
  return many(`SELECT * FROM order_items WHERE order_id=$1 ORDER BY id`, [orderId]);
}

export async function setOrderStatus(orderId, status, extra = {}) {
  const sets = ["status=$2", "updated_at=now()"];
  const params = [orderId, status];
  for (const [k, v] of Object.entries(extra)) {
    params.push(v);
    sets.push(`${k}=$${params.length}`);
  }
  return one(`UPDATE orders SET ${sets.join(", ")} WHERE id=$1 RETURNING *`, params);
}

/**
 * Queues a Shopify tag change. `add`/`remove` are keys of settings.tags (or raw tag strings prefixed with "=").
 * Tagging runs as its own retried job so a Shopify hiccup never re-sends a WhatsApp message.
 */
export async function queueTags(store, order, { add = [], remove = [] }) {
  const map = (keys) => keys.map((k) => (k.startsWith("=") ? k.slice(1) : store.settings.tags[k])).filter(Boolean);
  const addTags = map(add);
  const removeTags = map(remove).filter((t) => !addTags.includes(t));
  if (!addTags.length && !removeTags.length) return;
  // reflect locally right away so the portal shows the tags
  await query(
    `UPDATE orders SET shopify_tags = (
       SELECT COALESCE(array_agg(DISTINCT t), '{}') FROM unnest(array_cat(shopify_tags, $2::text[])) t WHERE NOT (t = ANY($3::text[]))
     ) WHERE id=$1`,
    [order.id, addTags, removeTags]
  );
  await enqueue("shopify.tags", { storeId: store.id, orderId: order.id, add: addTags, remove: removeTags });
}

export function isEligibleForConfirmation(store, order) {
  const c = store.settings.confirmation;
  if (!c.enabled) return false;
  if (c.scope === "cod" && !order.is_cod) return false;
  if (c.scope === "prepaid" && order.is_cod) return false;
  return true;
}

export async function logOrderEvent(order, msg, extra = {}) {
  logger.info({ store: order.store_id, order: order.id, ...extra }, msg);
}
