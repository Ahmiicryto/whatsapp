/**
 * Order lifecycle events. Each one runs (in the background) the merchant's automation rules,
 * outgoing webhooks and built-in follow-ups such as courier auto-booking or the upsell offer.
 */
import { enqueue } from "../queue/queue.js";

export const ORDER_EVENTS = ["order.created", "order.confirmed", "order.cancelled", "order.no_response", "shipment.delivered", "shipment.returned", "shipment.failed"];

export async function orderEvent(store, order, event, extra = {}) {
  await enqueue("order.event", { storeId: store.id, orderId: order.id, event, ...extra }, { singletonKey: `order:${order.id}:event:${event}:${extra.key || ""}` });
}
