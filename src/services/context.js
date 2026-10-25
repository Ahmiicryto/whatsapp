import { formatMoney, formatAddress, itemsSummary } from "../lib/format.js";
import { mapImageUrl } from "../google/address.js";

function prettyPhone(e164) {
  if (!e164) return "-";
  return e164.replace(/^(\+\d{2})(\d{3})(\d+)$/, "$1 $2 $3");
}

/** Flat template context (VARIABLES keys) for an order. */
export function orderContext(store, order, items = []) {
  const currency = order.currency || store.currency;
  const firstImage = items.find((i) => i.image_url)?.image_url || store.settings.defaultProductImage || store.logoUrl || null;
  const total = formatMoney(order.total, currency);
  const addressText = order.address_text || formatAddress(order.shipping_address);
  return {
    __ref: order.id,
    "customer.name": order.customer_name || "Customer",
    "customer.first_name": order.first_name || (order.customer_name || "").split(" ")[0] || "there",
    "customer.phone": prettyPhone(order.phone_e164),
    "store.name": store.name,
    "store.domain": store.shopifyDomain,
    "order.name": order.name,
    "order.total": total,
    "order.payment": order.is_cod ? "Cash on Delivery" : "Paid",
    "order.amount_due": order.is_cod ? `${total} (Cash on Delivery)` : "nothing, it is already paid",
    "order.items": itemsSummary(items, currency),
    "order.item_count": String(items.reduce((s, i) => s + Number(i.quantity || 0), 0)),
    "order.address": addressText || "-",
    "product.title": items[0]?.title || "your order",
    "product.image": firstImage,
    "address.text": addressText || "-",
    "address.map_image": mapImageUrl(order.lat, order.lng) || firstImage,
  };
}

export function customerContext(store, customer) {
  return {
    __ref: customer.id,
    "customer.name": customer.name || "Customer",
    "customer.first_name": customer.first_name || (customer.name || "").split(" ")[0] || "there",
    "customer.phone": prettyPhone(customer.phone_e164),
    "store.name": store.name,
    "store.domain": store.shopifyDomain,
  };
}
