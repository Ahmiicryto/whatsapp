import { parsePhoneNumberFromString } from "libphonenumber-js";

/** Returns E.164 (+923001234567) or null when the number can't be validated. */
export function normalizePhone(raw, defaultCountry) {
  if (!raw) return null;
  const cleaned = String(raw).trim().replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  const candidates = [cleaned];
  // Local numbers like 0300... or international without "+" like 92300...
  if (!cleaned.startsWith("+")) candidates.push(`+${cleaned.replace(/^00/, "")}`);
  for (const candidate of candidates) {
    const parsed = parsePhoneNumberFromString(candidate, defaultCountry || undefined);
    if (parsed && parsed.isValid()) return parsed.number;
  }
  return null;
}

/** WhatsApp Cloud API expects digits only in the "to" field. */
export function toWaId(e164) {
  return String(e164 || "").replace(/\D/g, "");
}

export function fromWaId(waId) {
  return waId ? `+${String(waId).replace(/\D/g, "")}` : null;
}

export function maskPhone(e164) {
  if (!e164) return "";
  return e164.length > 6 ? `${e164.slice(0, 4)}•••${e164.slice(-3)}` : e164;
}
