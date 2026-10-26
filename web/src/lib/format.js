export function money(v, currency = "USD") {
  const n = Number(v || 0);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: n >= 1000 || Number.isInteger(n) ? 0 : 2 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(0)}`;
  }
}

export const num = (v) => new Intl.NumberFormat().format(Number(v || 0));

export function compact(v) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(Number(v || 0));
}

export function dateTime(v) {
  if (!v) return "—";
  return new Date(v).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function date(v) {
  if (!v) return "—";
  return new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function ago(v) {
  if (!v) return "—";
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const STATUS_LABEL = {
  new: "New",
  no_phone: "No phone",
  not_eligible: "Not messaged",
  awaiting_reply: "Awaiting reply",
  confirmed: "Confirmed",
  cancelled_by_customer: "Cancelled by customer",
  no_response: "No response",
  cancelled: "Cancelled",
  fulfilled: "Shipped",
  delivered: "Delivered",
  returned: "Returned",
};

export const SHIP_LABEL = {
  booked: "Booked",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  attempted: "Delivery failed",
  refused: "Refused",
  returning: "Returning",
  returned: "Returned",
  cancelled: "Cancelled",
};
export const SHIP_TONE = {
  booked: "gray",
  in_transit: "blue",
  out_for_delivery: "purple",
  delivered: "green",
  attempted: "amber",
  refused: "red",
  returning: "orange",
  returned: "red",
  cancelled: "gray",
};

export const STATUS_TONE = {
  new: "gray",
  no_phone: "red",
  not_eligible: "gray",
  awaiting_reply: "amber",
  confirmed: "green",
  cancelled_by_customer: "red",
  no_response: "orange",
  cancelled: "red",
  fulfilled: "blue",
  delivered: "green",
  returned: "red",
};

export const ADDRESS_LABEL = {
  unchecked: "Unchecked",
  verified: "Verified",
  needs_confirmation: "Needs confirmation",
  needs_update: "Needs update",
  awaiting_customer: "Waiting for customer",
  updated: "Updated by customer",
  issue: "Issue",
};

export const ADDRESS_TONE = {
  unchecked: "gray",
  verified: "green",
  needs_confirmation: "amber",
  needs_update: "red",
  awaiting_customer: "amber",
  updated: "blue",
  issue: "red",
};
