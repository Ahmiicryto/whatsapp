/**
 * Real profit per day and per product: revenue from orders that weren't cancelled or returned,
 * minus product cost, courier fees, return costs, COD/payment fees, packaging and ad spend.
 * Costs a merchant hasn't entered are reported as missing rather than guessed.
 */
import { many } from "../db/pool.js";
import { getStoreContext } from "./stores.js";

const LOST = ["cancelled", "cancelled_by_customer", "returned"];

export async function computeProfit({ storeIds, from, to, timezone = "UTC" }) {
  const settings = {};
  for (const id of storeIds) settings[id] = (await getStoreContext(id))?.settings.profit || {};

  const days = await many(
    `SELECT o.store_id, to_char(o.shopify_created_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day,
            count(*)::int AS orders,
            count(*) FILTER (WHERE NOT (o.status = ANY($5)))::int AS kept,
            count(*) FILTER (WHERE o.status = 'returned')::int AS returned,
            COALESCE(sum(o.total) FILTER (WHERE NOT (o.status = ANY($5))), 0) AS revenue,
            COALESCE(sum(o.total) FILTER (WHERE NOT (o.status = ANY($5)) AND o.is_cod), 0) AS cod_revenue,
            COALESCE(sum((SELECT sum(i.quantity * COALESCE(i.unit_cost, 0)) FROM order_items i WHERE i.order_id=o.id)) FILTER (WHERE NOT (o.status = ANY($5))), 0) AS cogs,
            count(*) FILTER (WHERE NOT (o.status = ANY($5)) AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.unit_cost IS NULL))::int AS missing_cost,
            count(sh.id)::int AS shipped,
            COALESCE(sum(sh.fee), 0) AS courier_fees,
            count(sh.id) FILTER (WHERE sh.fee IS NULL)::int AS shipped_without_fee
       FROM orders o
       LEFT JOIN LATERAL (SELECT s.id, s.fee FROM shipments s WHERE s.order_id=o.id AND s.status <> 'cancelled' ORDER BY s.id DESC LIMIT 1) sh ON true
      WHERE o.store_id = ANY($1) AND o.shopify_created_at >= $2 AND o.shopify_created_at < $3
      GROUP BY 1, 2`,
    [storeIds, from, to, timezone, LOST]
  );
  const ads = await many(
    `SELECT store_id, to_char(day, 'YYYY-MM-DD') AS day, sum(amount) AS amount FROM ad_spend
      WHERE store_id = ANY($1) AND day >= ($2 AT TIME ZONE $4)::date AND day <= ($3 AT TIME ZONE $4)::date GROUP BY 1, 2`,
    [storeIds, from, to, timezone]
  );
  const adMap = Object.fromEntries(ads.map((a) => [`${a.store_id}:${a.day}`, Number(a.amount)]));

  const byDay = {};
  const totals = { orders: 0, kept: 0, returned: 0, revenue: 0, cogs: 0, shipping: 0, returnCost: 0, fees: 0, packaging: 0, ads: 0, profit: 0, missingCost: 0 };
  const add = (day, k, v) => {
    byDay[day] ||= { day, revenue: 0, cogs: 0, shipping: 0, returnCost: 0, fees: 0, packaging: 0, ads: 0, profit: 0, orders: 0 };
    byDay[day][k] += v;
    totals[k] = (totals[k] || 0) + v;
  };
  for (const d of days) {
    const p = settings[d.store_id];
    const shippedNoFee = Number(d.shipped_without_fee);
    const shipping = Number(d.courier_fees) + shippedNoFee * Number(p.shippingCost || 0);
    const returnCost = Number(d.returned) * Number(p.returnCost || 0);
    const fees = (Number(d.cod_revenue) * Number(p.codFeePercent || 0)) / 100 + (Number(d.revenue) * Number(p.otherPercent || 0)) / 100;
    const packaging = Number(d.shipped) * Number(p.packagingCost || 0);
    add(d.day, "orders", d.orders);
    add(d.day, "revenue", Number(d.revenue));
    add(d.day, "cogs", Number(d.cogs));
    add(d.day, "shipping", shipping);
    add(d.day, "returnCost", returnCost);
    add(d.day, "fees", fees);
    add(d.day, "packaging", packaging);
    totals.kept += d.kept;
    totals.returned += d.returned;
    totals.missingCost += d.missing_cost;
  }
  for (const [key, amount] of Object.entries(adMap)) add(key.split(":")[1], "ads", amount);
  for (const d of Object.values(byDay)) {
    d.profit = d.revenue - d.cogs - d.shipping - d.returnCost - d.fees - d.packaging - d.ads;
  }
  totals.profit = totals.revenue - totals.cogs - totals.shipping - totals.returnCost - totals.fees - totals.packaging - totals.ads;
  totals.margin = totals.revenue ? Math.round((totals.profit / totals.revenue) * 1000) / 10 : 0;
  totals.roas = totals.ads ? Math.round((totals.revenue / totals.ads) * 100) / 100 : null;
  totals.returnRate = totals.orders ? Math.round((totals.returned / totals.orders) * 1000) / 10 : 0;

  const products = await many(
    `SELECT i.product_id, max(i.title) AS title, max(i.image_url) AS image_url,
            sum(i.quantity) FILTER (WHERE NOT (o.status = ANY($4)))::int AS units,
            COALESCE(sum(i.quantity * i.price) FILTER (WHERE NOT (o.status = ANY($4))), 0) AS revenue,
            COALESCE(sum(i.quantity * COALESCE(i.unit_cost, 0)) FILTER (WHERE NOT (o.status = ANY($4))), 0) AS cogs,
            bool_or(i.unit_cost IS NULL) AS missing_cost,
            count(DISTINCT o.id) FILTER (WHERE o.status='returned')::int AS returned,
            count(DISTINCT o.id)::int AS orders
       FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE o.store_id = ANY($1) AND o.shopify_created_at >= $2 AND o.shopify_created_at < $3
      GROUP BY i.product_id ORDER BY revenue DESC LIMIT 50`,
    [storeIds, from, to, LOST]
  );
  return {
    totals,
    series: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
    products: products.map((p) => ({
      ...p,
      revenue: Number(p.revenue),
      cogs: Number(p.cogs),
      gross: Number(p.revenue) - Number(p.cogs),
      returnRate: p.orders ? Math.round((p.returned / p.orders) * 1000) / 10 : 0,
    })),
  };
}
