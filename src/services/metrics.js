import { one, many } from "../db/pool.js";
import { pct } from "../lib/format.js";

/**
 * All dashboard/report numbers for a set of stores and a period.
 * storeIds: array of ids, or null for every store (super admin).
 */
export async function computeMetrics({ storeIds, from, to, timezone = "UTC" }) {
  const scope = (a = "") => (storeIds ? `${a}store_id = ANY($1)` : "($1::bigint[] IS NULL)");
  const p = [storeIds, from, to];

  const k = await one(
    `SELECT count(*) AS orders,
            COALESCE(sum(total) FILTER (WHERE status NOT IN ('cancelled','cancelled_by_customer')),0) AS revenue,
            count(*) FILTER (WHERE confirmation_sent_at IS NOT NULL) AS confirmation_sent,
            count(*) FILTER (WHERE confirmed_at IS NOT NULL OR status='confirmed') AS confirmed,
            count(*) FILTER (WHERE status='cancelled_by_customer') AS cancelled_by_customer,
            count(*) FILTER (WHERE status='cancelled') AS cancelled,
            count(*) FILTER (WHERE status='no_response') AS no_response,
            count(*) FILTER (WHERE status='awaiting_reply') AS awaiting,
            count(*) FILTER (WHERE status IN ('fulfilled','delivered')) AS shipped,
            count(*) FILTER (WHERE status='delivered') AS delivered,
            count(*) FILTER (WHERE is_cod) AS cod,
            count(*) FILTER (WHERE address_status='verified') AS address_verified,
            count(*) FILTER (WHERE address_status='updated') AS address_updated,
            count(*) FILTER (WHERE address_status IN ('needs_update','needs_confirmation','awaiting_customer')) AS address_pending,
            count(*) FILTER (WHERE risk_score >= 60) AS high_risk,
            count(*) FILTER (WHERE needs_attention) AS needs_attention
       FROM orders WHERE ${scope()} AND shopify_created_at >= $2 AND shopify_created_at < $3`,
    p
  );
  const m = await one(
    `SELECT count(*) FILTER (WHERE direction='out') AS sent,
            count(*) FILTER (WHERE direction='out' AND status IN ('delivered','read')) AS delivered,
            count(*) FILTER (WHERE direction='out' AND status='read') AS read,
            count(*) FILTER (WHERE direction='out' AND status='failed') AS failed,
            count(*) FILTER (WHERE direction='in') AS received,
            count(*) FILTER (WHERE ai_generated) AS ai_replies,
            count(*) FILTER (WHERE category='marketing') AS marketing,
            COALESCE(sum(cost_estimate),0) AS cost
       FROM messages WHERE ${scope()} AND created_at >= $2 AND created_at < $3`,
    p
  );
  const series = await many(
    `SELECT to_char(date_trunc('day', shopify_created_at AT TIME ZONE $4), 'YYYY-MM-DD') AS day,
            count(*) AS orders,
            COALESCE(sum(total) FILTER (WHERE status NOT IN ('cancelled','cancelled_by_customer')),0) AS revenue,
            count(*) FILTER (WHERE confirmed_at IS NOT NULL OR status='confirmed') AS confirmed,
            count(*) FILTER (WHERE status IN ('cancelled','cancelled_by_customer')) AS cancelled,
            count(*) FILTER (WHERE status='no_response') AS no_response
       FROM orders WHERE ${scope()} AND shopify_created_at >= $2 AND shopify_created_at < $3
      GROUP BY 1 ORDER BY 1`,
    [...p, timezone]
  );
  const messageSeries = await many(
    `SELECT to_char(date_trunc('day', created_at AT TIME ZONE $4), 'YYYY-MM-DD') AS day,
            count(*) FILTER (WHERE direction='out') AS sent,
            count(*) FILTER (WHERE direction='out' AND status='read') AS read,
            count(*) FILTER (WHERE direction='in') AS received
       FROM messages WHERE ${scope()} AND created_at >= $2 AND created_at < $3 GROUP BY 1 ORDER BY 1`,
    [...p, timezone]
  );
  const statuses = await many(
    `SELECT status, count(*) AS n FROM orders WHERE ${scope()} AND shopify_created_at >= $2 AND shopify_created_at < $3 GROUP BY 1 ORDER BY 2 DESC`,
    p
  );
  const messageKinds = await many(
    `SELECT kind, count(*) AS n, count(*) FILTER (WHERE status='read') AS read FROM messages
      WHERE ${scope()} AND direction='out' AND created_at >= $2 AND created_at < $3 GROUP BY 1 ORDER BY 2 DESC`,
    p
  );
  const addressBuckets = await many(
    `SELECT CASE WHEN address_score IS NULL THEN 'unchecked' WHEN address_score >= 80 THEN '80-100'
                 WHEN address_score >= 50 THEN '50-79' ELSE '0-49' END AS bucket, count(*) AS n
       FROM orders WHERE ${scope()} AND shopify_created_at >= $2 AND shopify_created_at < $3 GROUP BY 1`,
    p
  );
  const topProducts = await many(
    `SELECT i.title, sum(i.quantity) AS qty, sum(i.quantity * i.price) AS revenue, max(i.image_url) AS image
       FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE ${scope("o.")} AND o.shopify_created_at >= $2 AND o.shopify_created_at < $3
        AND o.status NOT IN ('cancelled','cancelled_by_customer')
      GROUP BY i.title ORDER BY qty DESC LIMIT 8`,
    p
  );
  const topCities = await many(
    `SELECT COALESCE(NULLIF(initcap(shipping_address->>'city'),''),'Unknown') AS city, count(*) AS orders,
            count(*) FILTER (WHERE status IN ('cancelled','cancelled_by_customer')) AS cancelled,
            COALESCE(sum(total),0) AS revenue
       FROM orders WHERE ${scope()} AND shopify_created_at >= $2 AND shopify_created_at < $3
      GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
    p
  );
  const mapPoints = await many(
    `SELECT lat, lng FROM orders WHERE ${scope()} AND shopify_created_at >= $2 AND shopify_created_at < $3 AND lat IS NOT NULL
      ORDER BY shopify_created_at DESC LIMIT 60`,
    p
  );
  const campaigns = await one(
    `SELECT count(DISTINCT c.id) AS campaigns, count(r.id) FILTER (WHERE r.status='sent') AS sent,
            count(r.id) FILTER (WHERE r.clicked_at IS NOT NULL) AS clicked, count(r.order_id) AS orders,
            COALESCE(sum(r.revenue),0) AS revenue
       FROM campaigns c LEFT JOIN campaign_recipients r ON r.campaign_id=c.id
      WHERE ${scope("c.")} AND c.started_at >= $2 AND c.started_at < $3`,
    p
  );
  const carts = await one(
    `SELECT count(*) FILTER (WHERE ch.steps_sent > 0) AS reminded, count(*) FILTER (WHERE ch.status='recovered') AS recovered,
            COALESCE(sum(o.total) FILTER (WHERE ch.status='recovered'),0) AS recovered_revenue
       FROM checkouts ch LEFT JOIN orders o ON o.id = ch.recovered_order_id
      WHERE ${scope("ch.")} AND ch.created_at >= $2 AND ch.created_at < $3`,
    p
  );
  const ai = await one(
    `SELECT count(*) AS calls, COALESCE(sum(input_tokens + output_tokens),0) AS tokens, count(*) FILTER (WHERE NOT ok) AS errors
       FROM ai_logs WHERE ${scope()} AND created_at >= $2 AND created_at < $3`,
    p
  );

  const decided = Number(k.confirmed) + Number(k.cancelled_by_customer) + Number(k.no_response);
  return {
    period: { from, to, timezone },
    kpis: {
      ...k,
      aov: k.orders ? Math.round((Number(k.revenue) / Math.max(1, Number(k.orders) - Number(k.cancelled) - Number(k.cancelled_by_customer))) * 100) / 100 : 0,
      confirmation_rate: pct(Number(k.confirmed), decided || Number(k.confirmation_sent)),
      cancel_rate: pct(Number(k.cancelled_by_customer), decided || Number(k.confirmation_sent)),
    },
    messages: { ...m, delivery_rate: pct(Number(m.delivered), Number(m.sent)), read_rate: pct(Number(m.read), Number(m.sent)) },
    series,
    messageSeries,
    statuses,
    messageKinds,
    addressBuckets,
    topProducts,
    topCities,
    mapPoints,
    campaigns,
    carts,
    ai,
  };
}
