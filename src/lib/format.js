export function formatMoney(amount, currency = "USD") {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** Single line address used in messages and the portal. */
export function formatAddress(addr) {
  if (!addr) return "";
  const parts = [
    addr.address1,
    addr.address2,
    addr.landmark,
    addr.city,
    addr.province,
    addr.zip,
    addr.country,
  ]
    .map((p) => (p ? String(p).trim() : ""))
    .filter(Boolean);
  // drop consecutive duplicates (e.g. city == province)
  return parts.filter((p, i) => i === 0 || p.toLowerCase() !== parts[i - 1].toLowerCase()).join(", ");
}

/**
 * "2× Candle Set (Rs 1,500) · 1× Battery (Rs 300)" — trimmed to maxLen with "+N more".
 */
export function itemsSummary(items, currency, maxLen = 300) {
  const parts = (items || []).map((it) => {
    const title = it.variant_title && it.variant_title !== "Default Title" ? `${it.title} - ${it.variant_title}` : it.title;
    return `${it.quantity}× ${title} (${formatMoney(Number(it.price) * Number(it.quantity), currency)})`;
  });
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const next = out ? `${out} · ${parts[i]}` : parts[i];
    if (next.length > maxLen) {
      const remaining = parts.length - i;
      return `${out || parts[i].slice(0, maxLen - 12)} · +${remaining} more`;
    }
    out = next;
  }
  return out || "-";
}

/**
 * Meta rejects template parameters containing newlines, tabs or more than 4 consecutive spaces
 * (error 132018), and empty parameters.
 */
export function sanitizeParam(value, maxLen = 900) {
  let text = value === null || value === undefined ? "" : String(value);
  text = text.replace(/[\r\n\t]+/g, " · ").replace(/ {2,}/g, " ").trim();
  if (text.length > maxLen) text = `${text.slice(0, maxLen - 1)}…`;
  return text || "-";
}

export function truncate(text, n) {
  const s = String(text ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}
