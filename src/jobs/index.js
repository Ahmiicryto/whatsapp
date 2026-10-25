import { one, many, query } from "../db/pool.js";
import { enqueue } from "../queue/queue.js";
import { PermanentError } from "../lib/errors.js";
import { normalizePhone } from "../lib/phone.js";
import { formatMoney } from "../lib/format.js";
import { logger } from "../logger.js";
import { getStoreContext, invalidateStore } from "../services/stores.js";
import { ingestOrder, getOrder, getOrderItems, setOrderStatus, queueTags, isEligibleForConfirmation, upsertCustomer } from "../services/orders.js";
import { checkOrderAddress } from "../services/address.js";
import { scoreOrderRisk } from "../services/risk.js";
import * as confirmation from "../services/confirmation.js";
import { ingestFulfillment, notifyTracking, sendReviewRequest } from "../services/tracking.js";
import * as marketing from "../services/marketing.js";
import { raiseAlert, sendAlert } from "../services/alerts.js";
import { queueDueReports, runReport } from "../services/reports.js";
import { installDefaultTemplates, syncTemplates } from "../services/templates.js";
import { handleMessageEvent, handleStatusEvent, handleTemplateStatusEvent, handleQualityEvent } from "../services/inbound.js";
import { parseWebhook } from "../whatsapp/webhookParser.js";
import { normalizeWebhookOrder, fetchVariantImages, fetchOrdersSince, fetchOrder, addTags, removeTags, cancelOrder } from "../shopify/orders.js";
import { registerWebhooks } from "../shopify/webhooks.js";
import { splitBundles } from "../bundles/splitter.js";
import { tx } from "../db/pool.js";

async function activeStore(storeId) {
  const store = await getStoreContext(storeId);
  if (!store) throw new PermanentError(`store ${storeId} not found`);
  return store;
}

// ---------------------------------------------------------------- order pipeline

async function enrichImages(store, order) {
  const items = await getOrderItems(order.id);
  const missing = items.filter((i) => !i.image_url && (i.variant_id || i.product_id));
  if (!missing.length || !store.shopifyToken) return items;
  try {
    const { byVariant, byProduct } = await fetchVariantImages(store, missing.map((i) => i.variant_id), missing.map((i) => i.product_id));
    for (const it of missing) {
      const url = byVariant[it.variant_id] || byProduct[it.product_id];
      if (url) {
        await query(`UPDATE order_items SET image_url=$2 WHERE id=$1`, [it.id, url]);
        it.image_url = url;
      }
    }
  } catch (err) {
    logger.warn({ err: err.message, order: order.id }, "product image lookup failed");
  }
  return items;
}

/** New order: images, bundles, address score, risk, alerts, then queue the WhatsApp confirmation. */
export async function processOrder(store, orderId) {
  let order = await getOrder(orderId);
  if (!order || order.status !== "new") return;
  const items = await enrichImages(store, order);

  if (store.settings.bundles.enabled) {
    await enqueue("bundle.split", { storeId: store.id, orderId }, { singletonKey: `order:${orderId}:bundle` });
  }
  if (store.settings.address.enabled && order.shipping_address) {
    order = (await checkOrderAddress(store, order)).order;
  }
  if (store.settings.risk.enabled) {
    const risk = await scoreOrderRisk(store, order, items);
    order = await setOrderStatus(order.id, order.status, { risk_score: risk.score, risk_reasons: JSON.stringify(risk.reasons) });
    if (risk.score >= store.settings.risk.highThreshold) {
      await queueTags(store, order, { add: ["riskHigh"] });
      await setOrderStatus(order.id, order.status, { needs_attention: true });
      if (store.settings.alerts.highRisk) {
        await raiseAlert(store, "high_risk", `risk:${order.id}`, `High-risk order ${order.name} (${formatMoney(order.total, order.currency)}, score ${risk.score}): ${risk.reasons.slice(0, 3).join("; ")}`);
      }
    }
  }
  const hv = Number(store.settings.alerts.highValueOrder || 0);
  if (hv > 0 && Number(order.total) >= hv) {
    await raiseAlert(store, "high_value", `hv:${order.id}`, `High value order ${order.name} for ${formatMoney(order.total, order.currency)} from ${order.address_text || "unknown city"}`);
  }
  await marketing.attributeOrder(store, order);

  if (!isEligibleForConfirmation(store, order)) {
    await setOrderStatus(order.id, "not_eligible");
    return;
  }
  if (!order.phone_e164) {
    const updated = await setOrderStatus(order.id, "no_phone", { needs_attention: true });
    await queueTags(store, updated, { add: ["noPhone"] });
    return;
  }
  await enqueue("confirmation.send", { storeId: store.id, orderId: order.id }, {
    delayMs: Number(store.settings.confirmation.delayMinutes || 0) * 60000,
    singletonKey: `order:${order.id}:confirm:send`,
  });
}

async function handleShopifyWebhook({ storeId, topic, payload }) {
  const store = await activeStore(storeId);
  switch (topic) {
    case "orders/create":
    case "orders/updated":
    case "orders/cancelled":
    case "orders/paid":
    case "orders/fulfilled": {
      const { order, isNew } = await ingestOrder(store, normalizeWebhookOrder(payload), { source: "webhook" });
      if (isNew && store.active && order.status === "new") {
        await enqueue("order.process", { storeId, orderId: order.id }, { singletonKey: `order:${order.id}:process` });
      }
      return;
    }
    case "fulfillments/create":
    case "fulfillments/update": {
      const f = await ingestFulfillment(store, payload);
      if (!f) {
        const n = await fetchOrder(store, payload.order_id).catch(() => null);
        if (n) await ingestOrder(store, n, { source: "reconcile" });
        throw new Error("order not synced yet, retrying fulfillment");
      }
      return;
    }
    case "checkouts/create":
    case "checkouts/update":
      return marketing.ingestCheckout(store, payload);
    case "customers/create":
    case "customers/update": {
      const phone = normalizePhone(payload.phone || payload.default_address?.phone, payload.default_address?.country_code || store.country);
      await tx((client) =>
        upsertCustomer(client, store.id, {
          shopifyId: payload.id,
          firstName: payload.first_name,
          lastName: payload.last_name,
          phone,
          email: payload.email,
          city: payload.default_address?.city,
          country: payload.default_address?.country_code,
          tags: String(payload.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
          acceptsMarketing: payload.sms_marketing_consent?.state === "subscribed",
        })
      );
      return;
    }
    case "app/uninstalled":
      await query(`UPDATE stores SET status='disconnected', shopify_token_enc=NULL, updated_at=now() WHERE id=$1`, [storeId]);
      invalidateStore(storeId);
      await raiseAlert(store, "uninstalled", `uninstalled:${storeId}:${Date.now()}`, `The app was uninstalled from ${store.shopifyDomain}. Reconnect the store to resume automation.`);
      return;
    default:
      logger.info({ topic }, "ignored shopify webhook topic");
  }
}

async function handleWhatsAppWebhook({ body }) {
  for (const ev of parseWebhook(body)) {
    try {
      if (ev.type === "message") await handleMessageEvent(ev);
      else if (ev.type === "status") await handleStatusEvent(ev);
      else if (ev.type === "template_status") await handleTemplateStatusEvent(ev);
      else if (ev.type === "quality") await handleQualityEvent(ev);
    } catch (err) {
      // one bad event must not block the rest of the batch; re-queue it alone for retry
      logger.error({ err: err.message, type: ev.type }, "whatsapp event failed");
      await enqueue("wa.event", { ev });
    }
  }
}

async function handleWaEvent({ ev }) {
  if (ev.timestamp) ev.timestamp = new Date(ev.timestamp);
  if (ev.type === "message") return handleMessageEvent(ev);
  if (ev.type === "status") return handleStatusEvent(ev);
  if (ev.type === "template_status") return handleTemplateStatusEvent(ev);
  if (ev.type === "quality") return handleQualityEvent(ev);
}

// ---------------------------------------------------------------- store setup & reconciliation

async function backfill(store, days = 30) {
  const orders = await fetchOrdersSince(store, new Date(Date.now() - days * 86400000), 20);
  for (const n of orders) await ingestOrder(store, n, { source: "backfill" });
  await query(`UPDATE stores SET last_reconciled_at=now() WHERE id=$1`, [store.id]);
  return orders.length;
}

async function setupStore({ storeId }) {
  const store = await activeStore(storeId);
  const results = await registerWebhooks(store);
  await query(`UPDATE stores SET webhooks_registered_at=now() WHERE id=$1`, [store.id]);
  logger.info({ store: store.id, failed: results.filter((r) => !r.ok).map((r) => r.topic) }, "webhooks registered");
  await installDefaultTemplates(store, { submit: !!store.wa?.wabaId });
  await enqueue("store.backfill", { storeId, days: 30 }, { singletonKey: `store:${storeId}:backfill` });
}

async function reconcileAll() {
  const stores = await many(`SELECT s.id FROM stores s JOIN accounts a ON a.id=s.account_id WHERE s.status='active' AND a.status='active' AND s.shopify_token_enc IS NOT NULL`);
  for (const s of stores) {
    await enqueue("store.reconcile", { storeId: s.id }, { singletonKey: `store:${s.id}:reconcile`, maxAttempts: 1 });
  }
}

async function reconcileStore({ storeId }) {
  const store = await activeStore(storeId);
  const row = await one(`SELECT last_reconciled_at FROM stores WHERE id=$1`, [storeId]);
  const since = row.last_reconciled_at ? new Date(new Date(row.last_reconciled_at).getTime() - 10 * 60000) : new Date(Date.now() - 2 * 3600000);
  const startedAt = new Date();
  const orders = await fetchOrdersSince(store, since, 5);
  for (const n of orders) {
    const { order, isNew } = await ingestOrder(store, n, { source: "reconcile" });
    // A missed orders/create webhook: process it if it is recent enough to still confirm.
    if (isNew && order.status === "new" && Date.now() - new Date(order.shopify_created_at).getTime() < 3 * 3600000) {
      await enqueue("order.process", { storeId, orderId: order.id }, { singletonKey: `order:${order.id}:process` });
    } else if (isNew && order.status === "new") {
      await setOrderStatus(order.id, "not_eligible");
    }
  }
  await query(`UPDATE stores SET last_reconciled_at=$2 WHERE id=$1`, [storeId, startedAt]);
}

// ---------------------------------------------------------------- periodic checks

async function hourlyChecks() {
  await query(`UPDATE jobs SET status='queued', locked_at=NULL WHERE status='running' AND locked_at < now() - interval '15 minutes'`);
  await query(`DELETE FROM sessions WHERE expires_at < now()`);
  const stores = await many(`SELECT id FROM stores WHERE status='active'`);
  for (const s of stores) {
    const store = await getStoreContext(s.id);
    const spike = Number(store.settings.alerts.failedSpike || 0);
    if (spike > 0) {
      const f = await one(`SELECT count(*) AS n FROM messages WHERE store_id=$1 AND status='failed' AND created_at > now() - interval '1 hour'`, [s.id]);
      if (Number(f.n) >= spike) {
        await raiseAlert(store, "failed_spike", `failed:${s.id}:${new Date().toISOString().slice(0, 13)}`, `${f.n} WhatsApp messages failed in the last hour. Check your number status and templates.`);
      }
    }
    const low = Number(store.settings.alerts.lowConfirmationRate || 0);
    if (low > 0) {
      const r = await one(
        `SELECT count(*) FILTER (WHERE status='confirmed' OR confirmed_at IS NOT NULL) AS c, count(*) FILTER (WHERE confirmation_sent_at IS NOT NULL) AS s
           FROM orders WHERE store_id=$1 AND confirmation_sent_at > now() - interval '24 hours' AND confirmation_sent_at < now() - interval '6 hours'`,
        [s.id]
      );
      const rate = Number(r.s) ? (Number(r.c) / Number(r.s)) * 100 : 100;
      if (Number(r.s) >= 10 && rate < low) {
        await raiseAlert(store, "low_confirmation", `lowconf:${s.id}:${new Date().toISOString().slice(0, 10)}`, `Confirmation rate is ${Math.round(rate)}% over the last day (target ${low}%).`);
      }
    }
  }
}

async function dailyMaintenance() {
  const stores = await many(`SELECT id FROM stores WHERE status='active'`);
  for (const s of stores) {
    await marketing.computeRfm(s.id);
    const store = await getStoreContext(s.id);
    await marketing.queueWinBacks(store);
  }
  await query(`DELETE FROM jobs WHERE status='done' AND updated_at < now() - interval '7 days'`);
  await query(`DELETE FROM webhook_events WHERE received_at < now() - interval '30 days'`);
  await query(`DELETE FROM cron_runs WHERE created_at < now() - interval '3 days'`);
  await query(`DELETE FROM oauth_states WHERE created_at < now() - interval '1 day'`);
}

async function dispatchDueCampaigns() {
  const due = await many(`SELECT id, store_id FROM campaigns WHERE status='scheduled' AND schedule_at <= now()`);
  for (const c of due) {
    await enqueue("campaign.dispatch", { storeId: c.store_id, campaignId: c.id }, { singletonKey: `campaign:${c.id}:dispatch` });
  }
}

async function syncPendingTemplates() {
  const stores = await many(`SELECT DISTINCT store_id FROM templates WHERE status='PENDING'`);
  for (const s of stores) {
    const store = await getStoreContext(s.store_id);
    if (store?.wa?.wabaId) await syncTemplates(store).catch((err) => logger.warn({ err: err.message }, "template sync failed"));
  }
}

// ---------------------------------------------------------------- registry

const withStore = (fn) => async (data) => fn(await activeStore(data.storeId), data);

export const handlers = {
  "shopify.webhook": handleShopifyWebhook,
  "wa.webhook": handleWhatsAppWebhook,
  "wa.event": handleWaEvent,
  "order.process": withStore((store, d) => processOrder(store, d.orderId)),
  "bundle.split": withStore(async (store, d) => {
    const order = await getOrder(d.orderId);
    if (order) await splitBundles(store, order, await getOrderItems(order.id));
  }),
  "confirmation.send": withStore((store, d) => confirmation.sendConfirmation(store, d.orderId, { force: d.force })),
  "confirmation.reminder": withStore((store, d) => confirmation.sendReminder(store, d.orderId)),
  "confirmation.timeout": withStore((store, d) => confirmation.markNoResponse(store, d.orderId)),
  "address.check": withStore(async (store, d) => {
    const order = await getOrder(d.orderId);
    if (order) await checkOrderAddress(store, order, { source: "manual" });
  }),
  "address.request": withStore(async (store, d) => {
    const order = await getOrder(d.orderId);
    if (order) await confirmation.sendAddressCheck(store, order, null);
  }),
  "shopify.tags": withStore(async (store, d) => {
    const order = await getOrder(d.orderId);
    if (!order || !store.shopifyToken) return;
    if (d.add?.length) await addTags(store, order.shopify_order_id, d.add);
    if (d.remove?.length) await removeTags(store, order.shopify_order_id, d.remove);
  }),
  "shopify.cancel": withStore(async (store, d) => {
    const order = await getOrder(d.orderId);
    if (order && store.shopifyToken) {
      await cancelOrder(store, order.shopify_order_id);
      await setOrderStatus(order.id, "cancelled_by_customer", { cancelled_at: new Date() });
    }
  }),
  "tracking.notify": withStore((store, d) => notifyTracking(store, d.fulfillmentId, d.event)),
  "review.request": withStore((store, d) => sendReviewRequest(store, d.orderId)),
  "cart.step": withStore((store, d) => marketing.sendCartStep(store, d.checkoutId, d.step)),
  "campaign.dispatch": (d) => marketing.dispatchCampaign(d.campaignId).catch(async (err) => {
    if (err.permanent) await query(`UPDATE campaigns SET status='failed', stats = stats || $2, updated_at=now() WHERE id=$1`, [d.campaignId, { error: err.message }]);
    throw err;
  }),
  "campaign.batch": (d) => marketing.sendCampaignBatch(d.campaignId, d.recipientIds),
  "winback.send": withStore((store, d) => marketing.sendWinBack(store, d.customerId)),
  "alert.send": withStore((store, d) => sendAlert(store, d.alertId)),
  "report.run": (d) => runReport(d),
  "store.setup": setupStore,
  "store.backfill": withStore((store, d) => backfill(store, d.days)),
  "store.reconcile": reconcileStore,
  "templates.install": withStore((store) => installDefaultTemplates(store, { submit: true })),
  "cron.reconcile": reconcileAll,
  "cron.reports": () => queueDueReports(),
  "cron.campaigns": dispatchDueCampaigns,
  "cron.hourly": hourlyChecks,
  "cron.daily": dailyMaintenance,
  "cron.templates": syncPendingTemplates,
};

export const cronEntries = [
  { name: "campaigns", job: "cron.campaigns", everyMinutes: 1 },
  { name: "reconcile", job: "cron.reconcile", everyMinutes: 15 },
  { name: "reports", job: "cron.reports", everyMinutes: 15 },
  { name: "templates", job: "cron.templates", everyMinutes: 30 },
  { name: "hourly", job: "cron.hourly", atMinute: 7 },
  { name: "daily", job: "cron.daily", everyMinutes: 1440 },
];
