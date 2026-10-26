import { one, query } from "../db/pool.js";
import { enqueue } from "../queue/queue.js";
import { getOrder, getOrderItems, queueTags, setOrderStatus } from "./orders.js";
import { orderContext } from "./context.js";
import { sendTemplate } from "./messaging.js";
import { createShortLink } from "./links.js";
import { assertNotQuietHours } from "./confirmation.js";
import { scheduleReviewAsk } from "./reviews.js";

/** fulfillments/create|update webhook -> upsert fulfillment, queue the right notification. */
export async function ingestFulfillment(store, p) {
  const order = await one(`SELECT * FROM orders WHERE store_id=$1 AND shopify_order_id=$2`, [store.id, p.order_id]);
  if (!order) return null; // order sync will pick it up; fulfillment webhook may arrive first

  const trackingNumber = p.tracking_number || p.tracking_numbers?.[0] || null;
  const trackingUrl = p.tracking_url || p.tracking_urls?.[0] || null;
  const f = await one(
    `INSERT INTO fulfillments (store_id, order_id, shopify_fulfillment_id, status, tracking_number, tracking_company, tracking_url, shipment_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (shopify_fulfillment_id) DO UPDATE SET status=EXCLUDED.status, tracking_number=EXCLUDED.tracking_number,
       tracking_company=EXCLUDED.tracking_company, tracking_url=EXCLUDED.tracking_url,
       shipment_status=COALESCE(EXCLUDED.shipment_status, fulfillments.shipment_status), updated_at=now()
     RETURNING *`,
    [store.id, order.id, p.id, p.status, trackingNumber, p.tracking_company, trackingUrl, p.shipment_status]
  );
  if (p.status === "cancelled") return f;
  // Booked through our courier integration: the shipment drives the WhatsApp updates, not Shopify.
  if (trackingNumber && (await one(`SELECT 1 FROM shipments WHERE order_id=$1 AND tracking_number=$2`, [order.id, trackingNumber]))) return f;

  if (!["fulfilled", "delivered"].includes(order.status) && !["cancelled", "cancelled_by_customer"].includes(order.status)) {
    await setOrderStatus(order.id, "fulfilled");
  }
  const t = store.settings.tracking;
  if (!t.enabled) return f;
  const notified = f.notified || {};
  if (trackingNumber && notified.shipped !== trackingNumber) {
    await enqueue("tracking.notify", { storeId: store.id, fulfillmentId: f.id, event: "shipped" }, { singletonKey: `fulfillment:${f.id}:shipped:${trackingNumber}` });
  }
  if (p.shipment_status === "out_for_delivery" && t.outForDelivery && !notified.out_for_delivery) {
    await enqueue("tracking.notify", { storeId: store.id, fulfillmentId: f.id, event: "out_for_delivery" }, { singletonKey: `fulfillment:${f.id}:ofd` });
  }
  if (p.shipment_status === "delivered" && !notified.delivered) {
    await enqueue("tracking.notify", { storeId: store.id, fulfillmentId: f.id, event: "delivered" }, { singletonKey: `fulfillment:${f.id}:delivered` });
  }
  return f;
}

const KIND = { shipped: "order_shipped", out_for_delivery: "out_for_delivery", delivered: "order_delivered" };

export async function notifyTracking(store, fulfillmentId, event) {
  const f = await one(`SELECT * FROM fulfillments WHERE id=$1`, [fulfillmentId]);
  if (!f) return;
  const order = await getOrder(f.order_id);
  if (!order?.phone_e164 || ["cancelled", "cancelled_by_customer"].includes(order.status)) return;
  const notified = f.notified || {};
  if (event === "shipped" && notified.shipped === f.tracking_number) return;
  if (event !== "shipped" && notified[event]) return;
  if (event === "delivered") {
    await setOrderStatus(order.id, "delivered");
    await queueTags(store, order, { add: ["delivered"] });
  }
  if (event === "delivered" && !store.settings.tracking.delivered) return scheduleReview(store, order);
  if (event !== "out_for_delivery") assertNotQuietHours(store);

  const items = await getOrderItems(order.id);
  const ctx = orderContext(store, order, items);
  ctx["tracking.company"] = f.tracking_company || "our courier";
  ctx["tracking.number"] = f.tracking_number || "-";
  if (event === "shipped") {
    const target = f.tracking_url || order.order_status_url || `https://${store.shopifyDomain}`;
    ctx["link.code"] = await createShortLink({ storeId: store.id, targetUrl: target, kind: "tracking", orderId: order.id });
  }
  await sendTemplate(store, { kind: KIND[event], to: order.phone_e164, ctx, orderId: order.id, customerId: order.customer_id, messageKind: event === "shipped" ? "tracking" : event });

  notified[event] = event === "shipped" ? f.tracking_number : true;
  await query(`UPDATE fulfillments SET notified=$2, updated_at=now() WHERE id=$1`, [f.id, notified]);
  if (event === "shipped") await queueTags(store, order, { add: ["trackingSent"] });
  if (event === "delivered") await scheduleReview(store, order);
}

async function scheduleReview(store, order) {
  await scheduleReviewAsk(store, order);
  const r = store.settings.tracking.reviewRequest;
  if (!r.enabled || !r.url) return;
  await enqueue("review.request", { storeId: store.id, orderId: order.id }, {
    delayMs: Number(r.delayDays || 3) * 86400000,
    singletonKey: `order:${order.id}:review`,
  });
}

export async function sendReviewRequest(store, orderId) {
  const order = await getOrder(orderId);
  if (!order?.phone_e164) return;
  assertNotQuietHours(store);
  const items = await getOrderItems(order.id);
  const ctx = orderContext(store, order, items);
  ctx["link.code"] = await createShortLink({ storeId: store.id, targetUrl: store.settings.tracking.reviewRequest.url, kind: "review", orderId: order.id });
  await sendTemplate(store, { kind: "review_request", to: order.phone_e164, ctx, orderId: order.id, customerId: order.customer_id, messageKind: "review" });
}
