/** Minimal Stripe client (Checkout + webhook signature) without the SDK. */
import crypto from "node:crypto";
import { config } from "../config.js";
import { requestJson } from "../lib/http.js";
import { PermanentError } from "../lib/errors.js";

export const stripeConfigured = () => !!config.stripe.secretKey;

/** Stripe wants application/x-www-form-urlencoded with bracketed keys. */
function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripeRequest(path, params = {}, method = "POST") {
  if (!stripeConfigured()) throw new PermanentError("Card payments are not set up (STRIPE_SECRET_KEY is missing)");
  const res = await requestJson(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.stripe.secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : form(params).toString(),
  });
  if (!res.ok) throw new PermanentError(`Stripe: ${res.json?.error?.message || `HTTP ${res.status}`}`);
  return res.json;
}

/** Zero-decimal currencies are sent as-is; everything else in cents. */
const ZERO_DECIMAL = ["JPY", "KRW", "VND", "CLP", "PYG", "UGX", "XAF", "XOF"];
export const toMinor = (amount, currency) => (ZERO_DECIMAL.includes(String(currency).toUpperCase()) ? Math.round(amount) : Math.round(Number(amount) * 100));

export function verifyStripeSignature(rawBody, header, secret = config.stripe.webhookSecret, toleranceSec = 600) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const sigs = String(header)
    .split(",")
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
