import { one } from "../db/pool.js";
import { aiAvailable } from "../ai/provider.js";
import { riskReview } from "../ai/features.js";
import { logger } from "../logger.js";
import { networkRiskPoints } from "./fraud.js";

/**
 * Fake/risky COD order score 0-100 from rules (+ optional AI review).
 * Returns { score, reasons }.
 */
export async function scoreOrderRisk(store, order, items) {
  const reasons = [];
  let score = 0;
  const add = (n, reason) => {
    score += n;
    reasons.push(reason);
  };

  if (!order.phone_e164) add(35, "No valid phone number");
  if (order.address_score !== null && order.address_score !== undefined && order.address_score < 50) add(20, "Weak delivery address");

  if (order.phone_e164) {
    const history = await one(
      `SELECT count(*) FILTER (WHERE status IN ('cancelled_by_customer','cancelled')) AS cancelled,
              count(*) FILTER (WHERE status = 'no_response') AS no_response,
              count(*) FILTER (WHERE shopify_created_at > now() - interval '24 hours' AND id <> $3) AS last_day,
              count(*) FILTER (WHERE status IN ('fulfilled','delivered')) AS good
         FROM orders WHERE store_id=$1 AND phone_e164=$2`,
      [store.id, order.phone_e164, order.id]
    );
    if (history.cancelled > 0) add(Math.min(30, history.cancelled * 15), `${history.cancelled} earlier cancelled order(s)`);
    if (history.no_response > 0) add(Math.min(20, history.no_response * 10), `${history.no_response} earlier unanswered confirmation(s)`);
    if (history.last_day >= 2) add(15, `${history.last_day} other orders from this number in 24h`);
    if (history.good >= 2) {
      score -= 20;
      reasons.push(`${history.good} earlier delivered orders (trusted)`);
    }
  }

  const net = await networkRiskPoints(store, order);
  if (net.blocked) return { score: 100, reasons: net.reasons, blocked: net.blocked };
  score += net.score;
  reasons.push(...net.reasons);

  const avg = await one(
    `SELECT avg(total) AS aov FROM orders WHERE store_id=$1 AND shopify_created_at > now() - interval '90 days' AND id <> $2`,
    [store.id, order.id]
  );
  if (avg?.aov && Number(order.total) > Number(avg.aov) * 3 && order.is_cod) add(15, "COD order value is over 3× the store average");
  if (items.some((i) => Number(i.quantity) >= 6)) add(10, "Unusually large quantity of one item");
  const name = String(order.customer_name || "");
  if (name.length < 3 || /\d/.test(name) || /(.)\1{3,}/.test(name)) add(10, "Suspicious customer name");
  if (!order.is_cod) {
    score -= 25;
    reasons.push("Prepaid order");
  }

  if (store.settings.risk.useAi && score >= 30 && aiAvailable(store)) {
    try {
      const r = await riskReview(store, {
        name: order.customer_name,
        address: order.address_text,
        total: order.total,
        items: items.map((i) => ({ title: i.title, qty: i.quantity })),
        rule_reasons: reasons,
      });
      score += Math.max(-20, Math.min(40, r.adjustment));
      reasons.push(...r.reasons.map((x) => `AI: ${x}`));
    } catch (err) {
      logger.warn({ err: err.message }, "AI risk review failed");
    }
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}
