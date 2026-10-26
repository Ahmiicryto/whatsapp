/** "Notify me when it's back in stock" sign-ups and the WhatsApp message when stock returns. */
import { one, many, query } from "../db/pool.js";
import { formatMoney } from "../lib/format.js";
import { normalizePhone } from "../lib/phone.js";
import { logger } from "../logger.js";
import { sendTemplate } from "./messaging.js";
import { customerContext } from "./context.js";
import { createShortLink } from "./links.js";

export async function subscribeStock(store, { productId, variantId = null, phone, name }) {
  const e164 = normalizePhone(phone, store.country || undefined);
  if (!e164) throw new Error("Enter a valid WhatsApp number");
  const product = await one(`SELECT shopify_product_id FROM products WHERE store_id=$1 AND shopify_product_id=$2`, [store.id, productId]);
  if (!product) throw new Error("Product not found");
  const customer = await one(`SELECT id FROM customers WHERE store_id=$1 AND phone_e164=$2 LIMIT 1`, [store.id, e164]);
  await query(
    `INSERT INTO stock_alerts (store_id, shopify_product_id, variant_id, phone_e164, customer_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [store.id, productId, variantId, e164, customer?.id || null]
  );
  if (name && !customer) logger.info({ store: store.id }, "stock alert from a new contact");
  return { ok: true };
}

export async function onRestock(store, { productId, variantIds = [], any = false }) {
  const p = await one(`SELECT * FROM products WHERE store_id=$1 AND shopify_product_id=$2`, [store.id, productId]);
  if (!p) return 0;
  const waiting = await many(
    `SELECT * FROM stock_alerts WHERE store_id=$1 AND shopify_product_id=$2 AND status='waiting'
        AND (variant_id IS NULL ${any ? "OR true" : ""} OR variant_id = ANY($3))`,
    [store.id, productId, variantIds]
  );
  let sent = 0;
  for (const w of waiting) {
    const variant = (p.variants || []).find((v) => Number(v.id) === Number(w.variant_id));
    const target = variant ? `https://${store.shopifyDomain}/cart/${variant.id}:1` : p.online_url || `https://${store.shopifyDomain}/products/${p.handle}`;
    const customer = w.customer_id ? await one(`SELECT * FROM customers WHERE id=$1`, [w.customer_id]) : { id: null, phone_e164: w.phone_e164 };
    const ctx = customerContext(store, customer);
    ctx["product.title"] = variant && variant.title !== "Default Title" ? `${p.title} (${variant.title})` : p.title;
    ctx["product.image"] = variant?.image || p.image_url;
    ctx["product.price"] = formatMoney(variant?.price ?? p.price_min, p.currency || store.currency);
    ctx["link.code"] = await createShortLink({ storeId: store.id, targetUrl: target, kind: "back_in_stock" });
    try {
      await sendTemplate(store, { kind: "back_in_stock", to: w.phone_e164, ctx, customerId: w.customer_id, messageKind: "back_in_stock", skipOptInCheck: true });
      await query(`UPDATE stock_alerts SET status='sent', sent_at=now() WHERE id=$1`, [w.id]);
      sent++;
    } catch (err) {
      await query(`UPDATE stock_alerts SET status='failed' WHERE id=$1`, [w.id]);
      logger.warn({ err: err.message, alert: w.id }, "back in stock message failed");
    }
  }
  return sent;
}
