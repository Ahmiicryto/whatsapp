import { one, many, query } from "../db/pool.js";
import { enqueue } from "../queue/queue.js";
import { PermanentError, Reschedule } from "../lib/errors.js";
import { normalizePhone } from "../lib/phone.js";
import { formatMoney } from "../lib/format.js";
import { quietHoursEnd } from "../lib/time.js";
import { sleep } from "../lib/http.js";
import { randomToken } from "../lib/crypto.js";
import { fetchVariantImages, createDiscountCode } from "../shopify/orders.js";
import { sendTemplate, findTemplate } from "./messaging.js";
import { customerContext } from "./context.js";
import { createShortLink, withUtm } from "./links.js";
import { getStoreContext } from "./stores.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------- segments

export const SEGMENT_FIELDS = {
  total_spent: { type: "number", sql: "c.total_spent" },
  orders_count: { type: "number", sql: "c.orders_count" },
  days_since_last_order: { type: "number", sql: "EXTRACT(day FROM now() - c.last_order_at)" },
  days_since_first_order: { type: "number", sql: "EXTRACT(day FROM now() - c.first_order_at)" },
  city: { type: "text", sql: "lower(c.city)" },
  country: { type: "text", sql: "lower(c.country)" },
  rfm_segment: { type: "text", sql: "c.rfm_segment" },
  tag: { type: "tag", sql: "c.tags" },
  wa_opt_in: { type: "bool", sql: "c.wa_opt_in" },
  bought_product: { type: "product" },
};

const NUM_OPS = { gt: ">", gte: ">=", lt: "<", lte: "<=", eq: "=", neq: "<>" };

/** Rules JSON -> SQL WHERE fragment over `customers c`. Fields/ops are whitelisted; values are parameters. */
export function buildSegmentWhere(rules, params) {
  const conds = [];
  for (const c of rules?.conditions || []) {
    const f = SEGMENT_FIELDS[c.field];
    if (!f) throw new PermanentError(`Unknown segment field ${c.field}`);
    const p = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (f.type === "number") {
      const op = NUM_OPS[c.op];
      if (!op) throw new PermanentError(`Bad operator ${c.op}`);
      conds.push(`COALESCE(${f.sql}, ${c.field.startsWith("days") ? 99999 : 0}) ${op} ${p(Number(c.value))}`);
    } else if (f.type === "text") {
      const values = (Array.isArray(c.value) ? c.value : String(c.value).split(",")).map((v) => String(v).trim().toLowerCase()).filter(Boolean);
      if (c.op === "in" || c.op === "eq") conds.push(`${f.sql} = ANY(${p(values)})`);
      else if (c.op === "neq" || c.op === "not_in") conds.push(`(${f.sql} IS NULL OR NOT (${f.sql} = ANY(${p(values)})))`);
      else throw new PermanentError(`Bad operator ${c.op}`);
    } else if (f.type === "tag") {
      if (c.op === "not_contains") conds.push(`NOT (${p(String(c.value))} = ANY(c.tags))`);
      else conds.push(`${p(String(c.value))} = ANY(c.tags)`);
    } else if (f.type === "bool") {
      conds.push(`${f.sql} = ${p(c.value === true || c.value === "true")}`);
    } else if (f.type === "product") {
      const sub = `EXISTS (SELECT 1 FROM orders o JOIN order_items i ON i.order_id=o.id WHERE o.customer_id=c.id AND i.title ILIKE ${p(`%${c.value}%`)})`;
      conds.push(c.op === "not_contains" ? `NOT ${sub}` : sub);
    }
  }
  if (!conds.length) return "TRUE";
  return `(${conds.join(rules.match === "any" ? " OR " : " AND ")})`;
}

function reachableSql(requireOptIn) {
  return `c.phone_e164 IS NOT NULL AND c.opted_out_at IS NULL${requireOptIn ? " AND c.wa_opt_in" : ""}`;
}

export async function previewSegment(store, rules) {
  const params = [store.id];
  const where = buildSegmentWhere(rules, params);
  const reach = reachableSql(store.settings.marketing.requireOptIn);
  const counts = await one(
    `SELECT count(*) AS matched, count(*) FILTER (WHERE ${reach}) AS reachable FROM customers c WHERE c.store_id=$1 AND ${where}`,
    params
  );
  const sample = await many(
    `SELECT c.id, c.name, c.phone_e164, c.city, c.orders_count, c.total_spent, c.last_order_at, c.wa_opt_in, c.rfm_segment
       FROM customers c WHERE c.store_id=$1 AND ${where} ORDER BY c.last_order_at DESC NULLS LAST LIMIT 10`,
    params
  );
  return { ...counts, sample };
}

// ---------------------------------------------------------------- campaigns

export async function dispatchCampaign(campaignId) {
  const campaign = await one(`SELECT * FROM campaigns WHERE id=$1`, [campaignId]);
  if (!campaign || !["scheduled", "sending"].includes(campaign.status)) return;
  const store = await getStoreContext(campaign.store_id);
  if (!store?.active || !store.wa) throw new PermanentError("Store has no active WhatsApp number");
  if (store.wa.qualityRating === "RED") throw new PermanentError("WhatsApp number quality is RED: campaign paused to protect the number");
  const template = await one(`SELECT * FROM templates WHERE id=$1`, [campaign.template_id]);
  if (!template || template.status !== "APPROVED") throw new PermanentError("Campaign template is not approved");

  const segment = campaign.segment_id ? await one(`SELECT * FROM segments WHERE id=$1`, [campaign.segment_id]) : null;
  const params = [store.id, campaign.id, campaign.template_b_id ? Number(campaign.ab_split) / 100 : 1];
  const where = buildSegmentWhere(segment?.rules || { conditions: [] }, params);
  await query(
    `INSERT INTO campaign_recipients (campaign_id, customer_id, phone_e164, variant)
     SELECT $2, c.id, c.phone_e164, CASE WHEN random() < $3 THEN 'A' ELSE 'B' END
       FROM customers c
      WHERE c.store_id=$1 AND ${reachableSql(store.settings.marketing.requireOptIn)} AND ${where}
     ON CONFLICT (campaign_id, customer_id) DO NOTHING`,
    params
  );
  await query(`UPDATE campaigns SET status='sending', started_at=COALESCE(started_at, now()), updated_at=now() WHERE id=$1`, [campaign.id]);
  const pending = await many(`SELECT id FROM campaign_recipients WHERE campaign_id=$1 AND status='pending' ORDER BY id`, [campaign.id]);
  if (!pending.length) {
    await finishCampaignIfDone(campaign.id);
    return;
  }
  for (let i = 0; i < pending.length; i += 100) {
    const ids = pending.slice(i, i + 100).map((r) => r.id);
    await enqueue("campaign.batch", { storeId: store.id, campaignId: campaign.id, recipientIds: ids }, { singletonKey: `campaign:${campaign.id}:batch:${ids[0]}` });
  }
}

export async function sendCampaignBatch(campaignId, recipientIds) {
  const campaign = await one(`SELECT * FROM campaigns WHERE id=$1`, [campaignId]);
  if (!campaign || campaign.status !== "sending") return;
  const store = await getStoreContext(campaign.store_id);
  const end = quietHoursEnd(new Date(), store.timezone, store.settings.quietHours);
  if (end) throw new Reschedule(end, "quiet hours");
  const templates = {
    A: await one(`SELECT * FROM templates WHERE id=$1`, [campaign.template_id]),
    B: campaign.template_b_id ? await one(`SELECT * FROM templates WHERE id=$1`, [campaign.template_b_id]) : null,
  };
  const gap = 1000 / Math.max(1, Number(store.settings.marketing.messagesPerSecond || 10));
  const recipients = await many(
    `SELECT r.*, c.name, c.first_name, c.phone_e164 AS cphone FROM campaign_recipients r JOIN customers c ON c.id=r.customer_id
      WHERE r.id = ANY($1) AND r.status='pending'`,
    [recipientIds]
  );
  for (const r of recipients) {
    const tpl = (r.variant === "B" && templates.B) || templates.A;
    try {
      const ctx = { ...customerContext(store, { id: r.customer_id, name: r.name, first_name: r.first_name, phone_e164: r.cphone }), ...(campaign.variables || {}) };
      ctx["campaign.image"] = campaign.header_media_url || store.settings.defaultProductImage || store.logoUrl;
      if (campaign.discount?.percent) {
        const code = `WA-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
        await createDiscountCode(store, { code, percent: campaign.discount.percent, days: campaign.discount.days || 7, title: `Campaign ${campaign.name}` });
        ctx["discount.code"] = code;
        ctx["discount.percent"] = String(campaign.discount.percent);
        ctx["discount.days"] = String(campaign.discount.days || 7);
        await query(`UPDATE campaign_recipients SET discount_code=$2 WHERE id=$1`, [r.id, code]);
      }
      const target = withUtm(campaign.link_url || `https://${store.shopifyDomain}`, { campaign: `wa-${campaign.id}`, content: r.variant });
      const code = await createShortLink({ storeId: store.id, targetUrl: target, kind: "campaign", campaignId: campaign.id, recipientId: r.id });
      ctx["link.code"] = code;
      const msg = await sendTemplate(store, { template: tpl, to: r.cphone, ctx, customerId: r.customer_id, campaignId: campaign.id, messageKind: "campaign" });
      await query(`UPDATE campaign_recipients SET status='sent', message_id=$2, short_code=$3 WHERE id=$1`, [r.id, msg.id, code]);
    } catch (err) {
      await query(`UPDATE campaign_recipients SET status=$2 WHERE id=$1`, [r.id, err.permanent ? "skipped" : "failed"]);
      logger.warn({ campaign: campaign.id, recipient: r.id, err: err.message }, "campaign send failed");
    }
    await sleep(gap);
  }
  await finishCampaignIfDone(campaign.id);
}

async function finishCampaignIfDone(campaignId) {
  const left = await one(`SELECT count(*) AS n FROM campaign_recipients WHERE campaign_id=$1 AND status='pending'`, [campaignId]);
  if (Number(left.n) === 0) {
    await query(`UPDATE campaigns SET status='sent', finished_at=now(), updated_at=now() WHERE id=$1 AND status='sending'`, [campaignId]);
  }
}

export async function campaignStats(campaignId) {
  const byVariant = await many(
    `SELECT r.variant,
            count(*) AS recipients,
            count(*) FILTER (WHERE r.status='sent') AS sent,
            count(*) FILTER (WHERE r.status IN ('failed','skipped')) AS failed,
            count(*) FILTER (WHERE m.status IN ('delivered','read')) AS delivered,
            count(*) FILTER (WHERE m.status='read') AS read,
            count(*) FILTER (WHERE r.clicked_at IS NOT NULL) AS clicked,
            count(*) FILTER (WHERE r.order_id IS NOT NULL) AS orders,
            COALESCE(sum(r.revenue),0) AS revenue,
            COALESCE(sum(m.cost_estimate),0) AS cost
       FROM campaign_recipients r LEFT JOIN messages m ON m.id = r.message_id
      WHERE r.campaign_id=$1 GROUP BY r.variant ORDER BY r.variant`,
    [campaignId]
  );
  const total = byVariant.reduce(
    (acc, v) => {
      for (const k of Object.keys(acc)) acc[k] += Number(v[k] || 0);
      return acc;
    },
    { recipients: 0, sent: 0, failed: 0, delivered: 0, read: 0, clicked: 0, orders: 0, revenue: 0, cost: 0 }
  );
  return { total, byVariant };
}

// ---------------------------------------------------------------- attribution

/** Links a new order to the campaign / abandoned cart that produced it. */
export async function attributeOrder(store, order) {
  if (order.discount_codes?.length) {
    const r = await one(
      `UPDATE campaign_recipients SET order_id=$1, revenue=$2
        WHERE id = (SELECT r.id FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id
                     WHERE c.store_id=$3 AND r.discount_code = ANY($4) AND r.order_id IS NULL LIMIT 1)
        RETURNING id`,
      [order.id, order.total, store.id, order.discount_codes]
    );
    if (r) return;
  }
  if (order.customer_id) {
    await query(
      `UPDATE campaign_recipients SET order_id=$1, revenue=$2
        WHERE id = (SELECT r.id FROM campaign_recipients r JOIN messages m ON m.id=r.message_id
                     WHERE r.customer_id=$3 AND r.order_id IS NULL AND m.created_at > now() - ($4 || ' days')::interval
                     ORDER BY (r.clicked_at IS NOT NULL) DESC, m.created_at DESC LIMIT 1)`,
      [order.id, order.total, order.customer_id, String(store.settings.marketing.attributionDays || 7)]
    );
  }
  if (order.checkout_token) {
    await query(
      `UPDATE checkouts SET status = CASE WHEN steps_sent > 0 THEN 'recovered' ELSE 'completed' END,
              recovered_order_id = CASE WHEN steps_sent > 0 THEN $3::bigint ELSE NULL END, completed_at=now(), updated_at=now()
        WHERE store_id=$1 AND token=$2 AND status='open'`,
      [store.id, order.checkout_token, order.id]
    );
  }
}

// ---------------------------------------------------------------- abandoned carts

export async function ingestCheckout(store, p) {
  const token = p.token || p.cart_token;
  if (!token) return;
  if (p.completed_at) {
    await query(`UPDATE checkouts SET status='completed', completed_at=$3, updated_at=now() WHERE store_id=$1 AND token=$2 AND status='open'`, [store.id, token, p.completed_at]);
    return;
  }
  const phone = normalizePhone(p.phone || p.shipping_address?.phone || p.billing_address?.phone || p.customer?.phone, p.shipping_address?.country_code || store.country);
  if (!phone) return;
  const name = [p.shipping_address?.first_name || p.customer?.first_name, p.shipping_address?.last_name || p.customer?.last_name].filter(Boolean).join(" ") || null;
  const accepts = !!p.buyer_accepts_marketing || p.customer?.sms_marketing_consent?.state === "subscribed";

  let customer = await one(`SELECT * FROM customers WHERE store_id=$1 AND phone_e164=$2 ORDER BY id LIMIT 1`, [store.id, phone]);
  if (!customer) {
    customer = await one(
      `INSERT INTO customers (store_id, shopify_customer_id, name, first_name, phone_e164, email, wa_opt_in, opt_in_source, opt_in_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (store_id, shopify_customer_id) DO UPDATE SET updated_at=now() RETURNING *`,
      [store.id, p.customer?.id ?? null, name, name?.split(" ")[0] ?? null, phone, p.email ?? null, accepts, accepts ? "shopify_checkout" : null, accepts ? new Date() : null]
    );
  } else if (accepts && !customer.wa_opt_in && !customer.opted_out_at) {
    await query(`UPDATE customers SET wa_opt_in=true, opt_in_source='shopify_checkout', opt_in_at=now() WHERE id=$1`, [customer.id]);
  }

  const items = (p.line_items || []).map((li) => ({ title: li.title, quantity: li.quantity, price: Number(li.price || 0), variant_id: li.variant_id, product_id: li.product_id }));
  const row = await one(
    `INSERT INTO checkouts (store_id, token, customer_id, phone_e164, name, email, total, currency, line_items, recovery_url, accepts_marketing)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (store_id, token) DO UPDATE SET phone_e164=EXCLUDED.phone_e164, name=EXCLUDED.name, total=EXCLUDED.total,
       line_items=EXCLUDED.line_items, recovery_url=EXCLUDED.recovery_url, accepts_marketing=EXCLUDED.accepts_marketing, updated_at=now()
     RETURNING *`,
    [store.id, token, customer.id, phone, name, p.email ?? null, Number(p.total_price || 0), p.currency || store.currency, JSON.stringify(items), p.abandoned_checkout_url ?? null, accepts]
  );
  const cfg = store.settings.marketing.abandonedCart;
  if (cfg.enabled && row.status === "open" && row.steps_sent === 0 && cfg.steps?.length) {
    await enqueue("cart.step", { storeId: store.id, checkoutId: row.id, step: 0 }, {
      delayMs: Number(cfg.steps[0].delayMinutes ?? 30) * 60000,
      singletonKey: `checkout:${row.id}:step:0`,
    });
  }
}

export async function sendCartStep(store, checkoutId, step) {
  const co = await one(`SELECT * FROM checkouts WHERE id=$1`, [checkoutId]);
  if (!co || co.status !== "open" || co.steps_sent > step) return;
  const completed = await one(`SELECT id FROM orders WHERE store_id=$1 AND checkout_token=$2`, [store.id, co.token]);
  if (completed) {
    await query(`UPDATE checkouts SET status='completed', completed_at=now() WHERE id=$1`, [co.id]);
    return;
  }
  const end = quietHoursEnd(new Date(), store.timezone, store.settings.quietHours);
  if (end) throw new Reschedule(end, "quiet hours");
  const cfg = store.settings.marketing.abandonedCart;
  const stepCfg = cfg.steps[step] || {};
  const items = co.line_items || [];
  let image = store.settings.defaultProductImage || store.logoUrl;
  try {
    const imgs = await fetchVariantImages(store, items.map((i) => i.variant_id), items.map((i) => i.product_id));
    image = imgs.byVariant[items[0]?.variant_id] || imgs.byProduct[items[0]?.product_id] || image;
  } catch {
    /* keep fallback image */
  }
  const ctx = customerContext(store, { id: co.customer_id, name: co.name, first_name: co.name?.split(" ")[0], phone_e164: co.phone_e164 });
  ctx["product.image"] = image;
  ctx["checkout.items"] = items.length > 1 ? `${items[0].title} and ${items.length - 1} more item${items.length > 2 ? "s" : ""}` : items[0]?.title || "your items";
  ctx["checkout.total"] = formatMoney(co.total, co.currency);
  ctx["checkout.offer"] = "Your items are still available.";
  if (stepCfg.discountPercent) {
    const code = `CART-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
    await createDiscountCode(store, { code, percent: stepCfg.discountPercent, days: 2, title: "Abandoned cart" });
    ctx["checkout.offer"] = `Use code ${code} for ${stepCfg.discountPercent}% off.`;
    ctx["discount.code"] = code;
  }
  ctx["link.code"] = await createShortLink({ storeId: store.id, targetUrl: withUtm(co.recovery_url || `https://${store.shopifyDomain}/cart`, { campaign: "abandoned-cart", content: `step${step + 1}` }), kind: "cart" });
  await sendTemplate(store, { kind: "abandoned_cart", to: co.phone_e164, ctx, customerId: co.customer_id, messageKind: "abandoned_cart" });
  await query(`UPDATE checkouts SET steps_sent=$2, updated_at=now() WHERE id=$1`, [co.id, step + 1]);
  const next = cfg.steps[step + 1];
  if (next) {
    const delay = Math.max(1, Number(next.delayMinutes) - Number(stepCfg.delayMinutes || 0)) * 60000;
    await enqueue("cart.step", { storeId: store.id, checkoutId: co.id, step: step + 1 }, { delayMs: delay, singletonKey: `checkout:${co.id}:step:${step + 1}` });
  }
}

// ---------------------------------------------------------------- win-back & RFM

export async function queueWinBacks(store) {
  const cfg = store.settings.marketing.winBack;
  if (!cfg.enabled || !(await findTemplate(store.id, "win_back", store.settings.language))) return 0;
  const rows = await many(
    `SELECT c.id FROM customers c
      WHERE c.store_id=$1 AND ${reachableSql(store.settings.marketing.requireOptIn)}
        AND c.last_order_at BETWEEN now() - ($2 || ' days')::interval - interval '1 day' AND now() - ($2 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.customer_id=c.id AND m.kind='win_back' AND m.created_at > now() - interval '90 days')
      LIMIT 2000`,
    [store.id, String(cfg.days)]
  );
  for (const r of rows) {
    await enqueue("winback.send", { storeId: store.id, customerId: r.id }, { singletonKey: `winback:${r.id}` });
  }
  return rows.length;
}

export async function sendWinBack(store, customerId) {
  const c = await one(`SELECT * FROM customers WHERE id=$1 AND store_id=$2`, [customerId, store.id]);
  if (!c?.phone_e164) return;
  const end = quietHoursEnd(new Date(), store.timezone, store.settings.quietHours);
  if (end) throw new Reschedule(end, "quiet hours");
  const cfg = store.settings.marketing.winBack;
  const code = `BACK-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
  await createDiscountCode(store, { code, percent: cfg.discountPercent, days: cfg.validDays, title: "Win-back" });
  const ctx = customerContext(store, c);
  ctx["discount.code"] = code;
  ctx["discount.percent"] = String(cfg.discountPercent);
  ctx["discount.days"] = String(cfg.validDays);
  ctx["link.code"] = await createShortLink({ storeId: store.id, targetUrl: withUtm(`https://${store.shopifyDomain}/discount/${code}`, { campaign: "win-back" }), kind: "win_back" });
  await sendTemplate(store, { kind: "win_back", to: c.phone_e164, ctx, customerId: c.id, messageKind: "win_back" });
}

/** Nightly RFM segmentation (quintiles per store). */
export async function computeRfm(storeId) {
  await query(
    `WITH scored AS (
       SELECT id,
         ntile(5) OVER (ORDER BY last_order_at ASC) AS r,
         ntile(5) OVER (ORDER BY orders_count ASC) AS f,
         ntile(5) OVER (ORDER BY total_spent ASC) AS m
       FROM customers WHERE store_id=$1 AND orders_count > 0
     )
     UPDATE customers c SET rfm_segment = CASE
         WHEN s.r >= 4 AND s.f >= 4 AND s.m >= 4 THEN 'champions'
         WHEN s.r >= 3 AND s.f >= 3 THEN 'loyal'
         WHEN s.r >= 4 AND s.f <= 2 THEN 'new'
         WHEN s.r = 3 AND s.f <= 2 THEN 'promising'
         WHEN s.r <= 2 AND s.f >= 3 THEN 'at_risk'
         WHEN s.r <= 2 AND s.m >= 4 THEN 'cant_lose'
         ELSE 'hibernating' END
     FROM scored s WHERE c.id = s.id`,
    [storeId]
  );
}
