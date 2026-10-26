import { ApiError } from "../lib/http.js";

/** Normalized shipment statuses used everywhere in the app. */
export const STATUSES = ["booked", "in_transit", "out_for_delivery", "delivered", "attempted", "refused", "returning", "returned", "cancelled"];
export const FINAL_STATUSES = ["delivered", "returned", "cancelled"];
export const PROBLEM_STATUSES = ["attempted", "refused", "returning", "returned"];

/** Courier status text (any courier, any wording) -> normalized status. Order of checks matters. */
export function normalizeStatus(raw) {
  const t = String(raw || "").toLowerCase();
  if (!t) return "booked";
  if (/cancel/.test(t)) return "cancelled";
  if (/(return(ed)? to (shipper|origin|vendor|merchant|sender)|\brto\b.*(deliver|complete)|returned$|return delivered|rts delivered)/.test(t)) return "returned";
  if (/(return|rts|\brto\b|being returned|sent back)/.test(t)) return "returning";
  if (/(refus|reject|denied|not accepted)/.test(t)) return "refused";
  if (/(attempt|undeliver|not deliver|unable|not available|unavailable|not responding|incomplete address|address not found|closed|consignee not|customer not|re-?attempt|hold|pending delivery)/.test(t)) return "attempted";
  if (/(out for delivery|on route|en route to consignee|with rider|assigned to rider|\bofd\b|out-for-delivery)/.test(t)) return "out_for_delivery";
  if (/deliver/.test(t)) return "delivered";
  if (/(transit|arriv|dispatch|picked|pick up|shipped|departed|left|received at|hub|origin|destination|forwarded|in route|sorting)/.test(t)) return "in_transit";
  return "booked";
}

/** "+923001234567" -> "03001234567" (Pakistani couriers want the local format). */
export function localPhone(e164) {
  const s = String(e164 || "");
  if (s.startsWith("+92")) return `0${s.slice(3)}`;
  return s.replace(/^\+/, "");
}

/** Best city match from a courier's city list ({id, name}[]): exact, then prefix/contains. */
export function matchCity(cities, name) {
  if (!name || !cities?.length) return null;
  const n = String(name).trim().toLowerCase();
  return (
    cities.find((c) => String(c.name).toLowerCase() === n) ||
    cities.find((c) => String(c.name).toLowerCase().startsWith(n) || n.startsWith(String(c.name).toLowerCase())) ||
    cities.find((c) => String(c.name).toLowerCase().includes(n)) ||
    null
  );
}

export function courierError(provider, message, res) {
  return new ApiError(`${provider}: ${message}`, { status: res?.status, body: res?.json });
}

/** Read a.b.0.c from an object. */
export function pick(obj, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Fill {{order.name}}-style placeholders from a flat object, JSON-escaped when `json` is set. */
export function fillTemplate(text, vars, { json = false } = {}) {
  return String(text || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = vars[k] ?? "";
    return json ? JSON.stringify(String(v)).slice(1, -1) : String(v);
  });
}
