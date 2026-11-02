/**
 * Money overview: where every rupee is — collected, owed by couriers, on the road, advances,
 * lost to returns, spent on ads — plus stock value at cost and at retail.
 */
import { one, many } from "../db/pool.js";

export async function financeOverview({ storeIds, from, to, timezone = "UTC" }) {
  const [cod, couriers, advances, prepaid, ads, adChannels, stock, daily] = await Promise.all([
    one(
      `SELECT COALESCE(sum(cod_amount) FILTER (WHERE status='delivered' AND cod_settled_at IS NOT NULL AND cod_settled_at >= $2 AND cod_settled_at < $3), 0) AS collected,
              COALESCE(sum(cod_amount) FILTER (WHERE status='delivered' AND cod_settled_at IS NULL), 0) AS due,
              count(*) FILTER (WHERE status='delivered' AND cod_settled_at IS NULL)::int AS due_count,
              COALESCE(sum(cod_amount) FILTER (WHERE status IN ('booked','in_transit','out_for_delivery','attempted')), 0) AS on_road,
              count(*) FILTER (WHERE status IN ('booked','in_transit','out_for_delivery','attempted'))::int AS on_road_count,
              COALESCE(sum(cod_amount) FILTER (WHERE status IN ('returned','returning','refused') AND booked_at >= $2 AND booked_at < $3), 0) AS returned_value,
              count(*) FILTER (WHERE status IN ('returned','returning','refused') AND booked_at >= $2 AND booked_at < $3)::int AS returned_count,
              count(*) FILTER (WHERE status='returned' AND return_received_at IS NULL)::int AS returns_not_received,
              COALESCE(sum(fee) FILTER (WHERE booked_at >= $2 AND booked_at < $3), 0) AS courier_fees
         FROM shipments WHERE store_id = ANY($1)`,
      [storeIds, from, to]
    ),
    many(
      `SELECT COALESCE(courier_name, provider) AS courier,
              COALESCE(sum(cod_amount) FILTER (WHERE status='delivered' AND cod_settled_at IS NULL), 0) AS due,
              count(*) FILTER (WHERE status='delivered' AND cod_settled_at IS NULL)::int AS due_count,
              COALESCE(sum(cod_amount) FILTER (WHERE status IN ('booked','in_transit','out_for_delivery','attempted')), 0) AS on_road,
              COALESCE(sum(cod_amount) FILTER (WHERE cod_settled_at >= $2 AND cod_settled_at < $3), 0) AS collected,
              min(delivered_at) FILTER (WHERE status='delivered' AND cod_settled_at IS NULL) AS oldest_due
         FROM shipments WHERE store_id = ANY($1) GROUP BY 1 ORDER BY due DESC`,
      [storeIds, from, to]
    ),
    one(
      `SELECT COALESCE(sum(advance_amount) FILTER (WHERE advance_status='paid' AND advance_paid_at >= $2 AND advance_paid_at < $3), 0) AS collected,
              COALESCE(sum(advance_amount) FILTER (WHERE advance_status='requested'), 0) AS pending,
              count(*) FILTER (WHERE advance_status='requested')::int AS pending_count
         FROM orders WHERE store_id = ANY($1)`,
      [storeIds, from, to]
    ),
    one(
      `SELECT COALESCE(sum(total), 0) AS amount, count(*)::int AS orders FROM orders
        WHERE store_id = ANY($1) AND NOT is_cod AND shopify_created_at >= $2 AND shopify_created_at < $3 AND status NOT IN ('cancelled','cancelled_by_customer')`,
      [storeIds, from, to]
    ),
    one(
      `SELECT COALESCE(sum(amount), 0) AS spend, COALESCE(sum(purchases), 0)::int AS purchases, COALESCE(sum(purchase_value), 0) AS purchase_value,
              COALESCE(sum(clicks), 0)::bigint AS clicks, COALESCE(sum(impressions), 0)::bigint AS impressions
         FROM ad_spend WHERE store_id = ANY($1) AND day >= ($2 AT TIME ZONE $4)::date AND day <= ($3 AT TIME ZONE $4)::date`,
      [storeIds, from, to, timezone]
    ),
    many(
      `SELECT split_part(channel, ':', 1) AS channel, sum(amount) AS spend, bool_or(source='meta_api') AS synced
         FROM ad_spend WHERE store_id = ANY($1) AND day >= ($2 AT TIME ZONE $4)::date AND day <= ($3 AT TIME ZONE $4)::date GROUP BY 1 ORDER BY 2 DESC`,
      [storeIds, from, to, timezone]
    ),
    one(
      `SELECT COALESCE(sum(GREATEST(v.inv, 0) * COALESCE(p.cost_override, v.cost, p.cost, 0)), 0) AS at_cost,
              COALESCE(sum(GREATEST(v.inv, 0) * v.price), 0) AS at_retail,
              COALESCE(sum(GREATEST(v.inv, 0)), 0)::bigint AS units,
              count(DISTINCT p.id) FILTER (WHERE COALESCE(p.inventory, 0) <= 0)::int AS out_of_stock,
              count(DISTINCT p.id) FILTER (WHERE p.inventory > 0 AND p.inventory <= 5)::int AS low_stock,
              count(DISTINCT p.id) FILTER (WHERE COALESCE(p.cost_override, p.cost) IS NULL)::int AS missing_cost
         FROM products p
         CROSS JOIN LATERAL (
           SELECT COALESCE((x->>'inventory')::numeric, 0) AS inv, COALESCE((x->>'price')::numeric, 0) AS price, (x->>'cost')::numeric AS cost
             FROM jsonb_array_elements(CASE WHEN jsonb_array_length(p.variants) > 0 THEN p.variants ELSE jsonb_build_array(jsonb_build_object('inventory', p.inventory, 'price', p.price_min)) END) x
         ) v
        WHERE p.store_id = ANY($1) AND COALESCE(p.status, 'active') = 'active'`,
      [storeIds]
    ),
    many(
      `WITH days AS (SELECT generate_series(($2 AT TIME ZONE $4)::date, ($3 AT TIME ZONE $4)::date, interval '1 day')::date AS day)
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              COALESCE((SELECT sum(cod_amount) FROM shipments s WHERE s.store_id = ANY($1) AND (s.cod_settled_at AT TIME ZONE $4)::date = d.day), 0)
                + COALESCE((SELECT sum(advance_amount) FROM orders o WHERE o.store_id = ANY($1) AND o.advance_status='paid' AND (o.advance_paid_at AT TIME ZONE $4)::date = d.day), 0) AS collected,
              COALESCE((SELECT sum(cod_amount) FROM shipments s WHERE s.store_id = ANY($1) AND s.status='delivered' AND (s.delivered_at AT TIME ZONE $4)::date = d.day), 0) AS delivered,
              COALESCE((SELECT sum(amount) FROM ad_spend a WHERE a.store_id = ANY($1) AND a.day = d.day), 0) AS ads
         FROM days d ORDER BY d.day`,
      [storeIds, from, to, timezone]
    ),
  ]);
  const n = (v) => Number(v || 0);
  return {
    cash: {
      codCollected: n(cod.collected),
      advancesCollected: n(advances.collected),
      prepaid: n(prepaid.amount),
      total: n(cod.collected) + n(advances.collected) + n(prepaid.amount),
    },
    receivable: { dueFromCouriers: n(cod.due), dueCount: cod.due_count, onRoad: n(cod.on_road), onRoadCount: cod.on_road_count, advancesPending: n(advances.pending), advancesPendingCount: advances.pending_count },
    losses: { returnedValue: n(cod.returned_value), returnedCount: cod.returned_count, returnsNotReceived: cod.returns_not_received, courierFees: n(cod.courier_fees) },
    ads: { spend: n(ads.spend), purchases: ads.purchases, purchaseValue: n(ads.purchase_value), clicks: Number(ads.clicks), impressions: Number(ads.impressions), channels: adChannels.map((c) => ({ ...c, spend: n(c.spend) })) },
    stock: { atCost: n(stock.at_cost), atRetail: n(stock.at_retail), units: Number(stock.units), outOfStock: stock.out_of_stock, lowStock: stock.low_stock, missingCost: stock.missing_cost },
    couriers: couriers.map((c) => ({ ...c, due: n(c.due), onRoad: n(c.on_road), collected: n(c.collected) })),
    series: daily.map((d) => ({ day: d.day, collected: Math.round(n(d.collected)), delivered: Math.round(n(d.delivered)), ads: Math.round(n(d.ads)) })),
  };
}
