import { one, query } from "../db/pool.js";
import { scoreAddress } from "../google/address.js";
import { formatAddress } from "../lib/format.js";
import { aiAvailable } from "../ai/provider.js";
import { assessAddress } from "../ai/features.js";
import { updateShippingAddress } from "../shopify/orders.js";
import { queueTags } from "./orders.js";
import { countUsage } from "./audit.js";
import { logger } from "../logger.js";

export function statusForScore(settings, score) {
  if (score >= settings.address.verifyThreshold) return "verified";
  if (score >= settings.address.updateThreshold) return "needs_confirmation";
  return "needs_update";
}

/** Scores the order's address with Google (+AI), stores the check and returns the updated order. */
export async function checkOrderAddress(store, order, { source } = {}) {
  const s = store.settings.address;
  const addr = order.shipping_address || {};
  let result;
  try {
    result = await scoreAddress(addr, { regionCode: addr.countryCode || store.country, key: store.apiKeys.google, provider: s.provider });
  } catch (err) {
    logger.warn({ err: err.message, order: order.id }, "google address check failed, using heuristics");
    result = await scoreAddress(addr, { regionCode: addr.countryCode || store.country, key: null, provider: "none" });
  }

  // Blend in an AI completeness review when Google isn't decisive.
  if (s.useAi && aiAvailable(store) && (result.source !== "google_validation" || result.score < s.verifyThreshold)) {
    try {
      const ai = await assessAddress(store, formatAddress(addr), addr.country || store.country);
      result.reasons.push(...ai.missing.map((m) => `AI: missing ${m}`));
      result.aiScore = ai.score;
      result.score = Math.round(result.score * 0.6 + ai.score * 0.4);
    } catch (err) {
      logger.warn({ err: err.message }, "AI address assessment failed");
    }
  }

  const city = String(addr.city || "").toLowerCase();
  if (s.blockedCities?.some((c) => c && city === String(c).toLowerCase())) {
    result.score = 0;
    result.reasons.push(`We don't deliver to ${addr.city}`);
  }

  await query(
    `INSERT INTO address_checks (store_id, order_id, source, input, result, score) VALUES ($1,$2,$3,$4,$5,$6)`,
    [store.id, order.id, source || result.source, addr, { reasons: result.reasons, formatted: result.formatted, aiScore: result.aiScore ?? null, ...result.raw }, result.score]
  );
  await countUsage(store.accountId, "address_checks");

  const status = statusForScore(store.settings, result.score);
  const updated = await one(
    `UPDATE orders SET address_score=$2, address_status=CASE WHEN address_status IN ('updated') AND $3 <> 'verified' THEN address_status ELSE $3 END,
       lat=COALESCE($4, lat), lng=COALESCE($5, lng), updated_at=now() WHERE id=$1 RETURNING *`,
    [order.id, result.score, status, result.lat, result.lng]
  );
  if (status === "verified") await queueTags(store, updated, { add: ["addressVerified"], remove: ["addressIssue"] });
  if (result.score === 0) await queueTags(store, updated, { add: ["addressIssue"] });
  return { order: updated, result };
}

/**
 * Applies an address the customer confirmed (typed + AI parsed, or location pin).
 * Writes it back to Shopify when enabled and tags the order.
 */
export async function applyCustomerAddress(store, order, addr, { source }) {
  const merged = {
    ...(order.shipping_address || {}),
    address1: addr.address1 || order.shipping_address?.address1,
    address2: [addr.address2, addr.landmark].filter(Boolean).join(", ") || null,
    city: addr.city || order.shipping_address?.city,
    province: addr.province || order.shipping_address?.province,
    provinceCode: addr.provinceCode || order.shipping_address?.provinceCode,
    zip: addr.zip || order.shipping_address?.zip,
    countryCode: addr.countryCode || addr.country_code || order.shipping_address?.countryCode,
    country: addr.country || order.shipping_address?.country,
    latitude: addr.lat ?? order.shipping_address?.latitude ?? null,
    longitude: addr.lng ?? order.shipping_address?.longitude ?? null,
  };
  const text = formatAddress(merged);
  if (store.settings.address.writeBackToShopify && store.shopifyToken) {
    await updateShippingAddress(store, order.shopify_order_id, merged);
  }
  await query(`INSERT INTO address_checks (store_id, order_id, source, input, result, score) VALUES ($1,$2,$3,$4,$5,$6)`, [
    store.id,
    order.id,
    source,
    { previous: order.shipping_address },
    { applied: merged },
    100,
  ]);
  const updated = await one(
    `UPDATE orders SET shipping_address=$2, address_text=$3, address_status='updated', address_score=GREATEST(COALESCE(address_score,0), 85),
       lat=COALESCE($4, lat), lng=COALESCE($5, lng), updated_at=now() WHERE id=$1 RETURNING *`,
    [order.id, merged, text, addr.lat ?? null, addr.lng ?? null]
  );
  await queueTags(store, updated, { add: ["addressUpdated"], remove: ["addressIssue"] });
  return updated;
}
