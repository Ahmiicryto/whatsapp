/** One-tap add-on offer right after a customer confirms on WhatsApp ("Add a matching candle for Rs 499?"). */
import { one, query } from "../db/pool.js";
import { formatMoney } from "../lib/format.js";
import { logger } from "../logger.js";
import * as wa from "../whatsapp/cloudApi.js";
import { fillText } from "./settings.js";
import { getOrder, ingestOrder, queueTags } from "./orders.js";
import { sendSession, sendText, upsertConversation, canMessageFreely } from "./messaging.js";
import { addVariantToOrder } from "../shopify/fulfillment.js";
import { fetchOrder } from "../shopify/orders.js";
import { notify } from "./notifications.js";

function offerOf(store) {
  const u = store.settings.upsell;
  return { ...u, discountPercent: Number(u.discountPercent || 0) };
}

export async function sendUpsellOffer(store, orderId) {
  const u = offerOf(store);
  const order = await getOrder(orderId);
  if (!u.enabled || !u.variantId || !order?.phone_e164 || order.status !== "confirmed" || order.upsell) return;
  if ((await one(`SELECT 1 FROM shipments WHERE order_id=$1 AND status <> 'cancelled'`, [order.id]))) return;
  const conversation = await upsertConversation(store.id, order.phone_e164, { customerId: order.customer_id });
  if (!canMessageFreely(store, conversation)) return;
  const product = await one(`SELECT title, image_url, variants, currency FROM products WHERE store_id=$1 AND variants @> $2::jsonb`, [store.id, JSON.stringify([{ id: Number(u.variantId) }])]);
  const variant = product?.variants?.find((v) => Number(v.id) === Number(u.variantId));
  const basePrice = Number(u.price || variant?.price || 0);
  const price = u.discountPercent ? basePrice * (1 - u.discountPercent / 100) : basePrice;
  const title = u.title || product?.title || "this item";
  const body = fillText(u.text || "Add {{product}} to your order for just {{price}}?", { product: title, price: formatMoney(price, order.currency) });
  const image = u.imageUrl || variant?.image || product?.image_url;
  await sendSession(store, {
    to: order.phone_e164,
    conversation,
    orderId: order.id,
    kind: "upsell_offer",
    body,
    payload: wa.buttonsPayload({
      body,
      header: image ? { type: "image", image: { link: image } } : undefined,
      buttons: [
        { id: `UPSELL_YES:${order.id}`, title: "Yes, add it" },
        { id: `UPSELL_NO:${order.id}`, title: "No, thanks" },
      ],
    }),
  });
  await query(`UPDATE orders SET upsell=$2 WHERE id=$1`, [order.id, { offered_at: new Date().toISOString(), variantId: Number(u.variantId), price }]);
}

export async function acceptUpsell(store, order, conversation) {
  const u = offerOf(store);
  const state = order.upsell || {};
  if (state.accepted) return sendText(store, { to: order.phone_e164, conversation, orderId: order.id, kind: "upsell_reply", body: "It's already added to your order ✅" });
  if (await one(`SELECT 1 FROM shipments WHERE order_id=$1 AND status <> 'cancelled'`, [order.id])) {
    return sendText(store, { to: order.phone_e164, conversation, orderId: order.id, kind: "upsell_reply", body: "Sorry, your order has already been dispatched, so we can't add to it now." });
  }
  try {
    const newTotal = await addVariantToOrder(store, order.shopify_order_id, { variantId: state.variantId || u.variantId, discountPercent: u.discountPercent });
    const fresh = await fetchOrder(store, order.shopify_order_id).catch(() => null);
    if (fresh) await ingestOrder(store, fresh, { source: "upsell" });
    await query(`UPDATE orders SET upsell = upsell || $2 WHERE id=$1`, [order.id, { accepted: true, accepted_at: new Date().toISOString() }]);
    await queueTags(store, order, { add: ["upsell"] });
    await sendText(store, { to: order.phone_e164, conversation, orderId: order.id, kind: "upsell_reply", body: `Added ✅ Your new order total is ${formatMoney(newTotal || order.total, order.currency)}. Thank you!` });
    await notify({ accountId: store.accountId, storeId: store.id, kind: "upsell.accepted", severity: "success", title: `Upsell accepted on ${order.name}`, body: `New total ${formatMoney(newTotal, order.currency)}`, link: `/orders/${order.id}` });
  } catch (err) {
    logger.warn({ err: err.message, order: order.id }, "upsell order edit failed");
    await query(`UPDATE orders SET upsell = upsell || $2, needs_attention=true WHERE id=$1`, [order.id, { accepted: true, failed: err.message }]);
    await sendText(store, { to: order.phone_e164, conversation, orderId: order.id, kind: "upsell_reply", body: "Great choice! Our team will add it to your order shortly ✅" });
    await notify({ accountId: store.accountId, storeId: store.id, kind: "upsell.manual", severity: "warning", title: `Add the upsell to ${order.name} by hand`, body: err.message, link: `/orders/${order.id}` });
  }
}

export async function declineUpsell(store, order) {
  await query(`UPDATE orders SET upsell = COALESCE(upsell, '{}'::jsonb) || $2 WHERE id=$1`, [order.id, { declined: true }]);
}
