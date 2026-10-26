import { one, many, query } from "../db/pool.js";
import { formatMoney } from "../lib/format.js";
import { config } from "../config.js";
import { getOrder, queueTags, setOrderStatus, logOrderEvent } from "./orders.js";
import { sendTemplate, sendText, upsertConversation, canMessageFreely } from "./messaging.js";
import { orderContext } from "./context.js";
import { getOrderItems } from "./orders.js";
import { notify } from "./notifications.js";
import { stripeConfigured, stripeRequest, toMinor } from "./stripe.js";
import { enqueue } from "../queue/queue.js";

/**
 * A phone number's delivery record across EVERY store on the platform (the network effect:
 * a customer who refused parcels at other shops is risky for you too). Store names stay private.
 */
export async function phoneReputation(phone, { excludeOrderId = 0, accountId = null } = {}) {
  if (!phone) return null;
  const r = await one(
    `SELECT count(*)::int AS orders,
            count(DISTINCT o.store_id)::int AS stores,
            count(*) FILTER (WHERE o.status='delivered')::int AS delivered,
            count(*) FILTER (WHERE o.status='returned' OR EXISTS (SELECT 1 FROM shipments s WHERE s.order_id=o.id AND s.status IN ('returned','returning','refused')))::int AS returned,
            count(*) FILTER (WHERE o.status IN ('cancelled','cancelled_by_customer'))::int AS cancelled,
            count(*) FILTER (WHERE o.status='no_response')::int AS no_response,
            max(o.shopify_created_at) AS last_order_at
       FROM orders o WHERE o.phone_e164=$1 AND o.id <> $2`,
    [phone, excludeOrderId]
  );
  const blocked = await isBlocked(accountId, phone);
  const finished = r.delivered + r.returned;
  const deliveryRate = finished ? Math.round((r.delivered / finished) * 100) : null;
  let level = "new";
  if (blocked) level = "blocked";
  else if (r.returned >= 2 || (finished >= 3 && deliveryRate < 50)) level = "bad";
  else if (r.returned >= 1 || r.cancelled >= 2 || r.no_response >= 2) level = "risky";
  else if (r.delivered >= 2) level = "trusted";
  return { ...r, deliveryRate, level, blocked: blocked ? { reason: blocked.reason, platform: !blocked.account_id } : null };
}

export async function isBlocked(accountId, phone) {
  if (!phone) return null;
  return one(`SELECT * FROM blocklist WHERE phone_e164=$1 AND (account_id IS NULL OR account_id=$2) ORDER BY account_id NULLS LAST LIMIT 1`, [phone, accountId]);
}

export async function blockPhone({ accountId, phone, reason, source = "manual", userId = null }) {
  return one(
    `INSERT INTO blocklist (account_id, phone_e164, reason, source, created_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (COALESCE(account_id, 0), phone_e164) DO UPDATE SET reason=EXCLUDED.reason RETURNING *`,
    [accountId, phone, reason || null, source, userId]
  );
}

/** Risk points from the network record (used by the order risk score). */
export async function networkRiskPoints(store, order) {
  const reasons = [];
  let score = 0;
  if (!order.phone_e164) return { score, reasons };
  const blocked = await isBlocked(store.accountId, order.phone_e164);
  if (blocked) return { score: 100, reasons: [`Blocked number${blocked.reason ? `: ${blocked.reason}` : ""}`], blocked };
  if (!store.settings.fraud.networkCheck) return { score, reasons };
  const rep = await phoneReputation(order.phone_e164, { excludeOrderId: order.id, accountId: store.accountId });
  if (rep.returned > 0) {
    score += Math.min(45, rep.returned * 20);
    reasons.push(`Refused or returned ${rep.returned} parcel(s) across ${rep.stores} store(s) on the network`);
  }
  if (rep.delivered >= 2 && rep.returned === 0) {
    score -= 10;
    reasons.push(`${rep.delivered} parcels delivered across the network`);
  }
  return { score, reasons };
}

/** Numbers that keep refusing parcels are blocked for this business automatically. */
export async function autoBlockCheck(store, order) {
  const n = Number(store.settings.fraud.autoBlockAfterReturns || 0);
  if (!n || !order.phone_e164) return false;
  const r = await one(
    `SELECT count(*)::int AS n FROM orders o JOIN stores s ON s.id=o.store_id
      WHERE s.account_id=$1 AND o.phone_e164=$2 AND (o.status='returned' OR EXISTS (SELECT 1 FROM shipments sh WHERE sh.order_id=o.id AND sh.status IN ('returned','refused')))`,
    [store.accountId, order.phone_e164]
  );
  if (r.n < n || (await isBlocked(store.accountId, order.phone_e164))) return false;
  await blockPhone({ accountId: store.accountId, phone: order.phone_e164, reason: `${r.n} refused/returned parcels`, source: "auto_returns" });
  await notify({ accountId: store.accountId, storeId: store.id, kind: "fraud.blocked", severity: "warning", title: `${order.phone_e164} was blocked automatically`, body: `${r.n} parcels refused or returned. Future orders from this number are flagged.`, link: "/fraud" });
  return true;
}

/** Advance amount this order needs (0 = none), from the store's advance-payment rules. */
export function advanceAmountFor(store, order) {
  const a = store.settings.advance;
  if (!a.enabled || !order.is_cod || ["paid", "waived"].includes(order.advance_status)) return 0;
  const total = Number(order.total);
  const risky = Number(order.risk_score || 0) >= Number(a.riskThreshold || 60);
  const applies = a.mode === "all_cod" ? total >= Number(a.minTotal || 0) : a.mode === "over_amount" ? total >= Number(a.minTotal || 0) : risky;
  if (!applies) return 0;
  if (a.type === "full") return total;
  if (a.type === "percent") return Math.ceil((total * Number(a.percent || 0)) / 100);
  return Math.min(total, Number(a.amount || 0));
}

/** Ask the customer to pay part of a COD order upfront (wallet/bank instructions and/or a card link). */
export async function requestAdvance(store, order, { amount, userId } = {}) {
  amount = Number(amount || advanceAmountFor(store, order) || store.settings.advance.amount);
  if (!(amount > 0)) throw new Error("Advance amount must be more than 0");
  let link = null;
  if (store.settings.advance.cardLink && stripeConfigured()) {
    const session = await stripeRequest("/checkout/sessions", {
      mode: "payment",
      success_url: `${config.baseUrl}/paid`,
      cancel_url: `${config.baseUrl}/paid?cancelled=1`,
      line_items: { 0: { quantity: 1, price_data: { currency: String(order.currency || store.currency).toLowerCase(), unit_amount: toMinor(amount, order.currency || store.currency), product_data: { name: `Advance for order ${order.name} (${store.name})` } } } },
      metadata: { kind: "advance", orderId: String(order.id), storeId: String(store.id) },
    });
    link = session.url;
  }
  const updated = await setOrderStatus(order.id, order.status, { advance_amount: amount, advance_status: "requested", advance_link: link, needs_attention: false });
  await queueTags(store, updated, { add: ["advanceRequested"] });
  await logOrderEvent(updated, `Advance of ${formatMoney(amount, order.currency)} requested`, { userId });
  if (updated.phone_e164) {
    const instructions = [store.settings.advance.instructions, link ? `Pay by card: ${link}` : null].filter(Boolean).join("\n");
    const conversation = await upsertConversation(store.id, updated.phone_e164, { customerId: updated.customer_id });
    if (canMessageFreely(store, conversation)) {
      await sendText(store, {
        to: updated.phone_e164,
        conversation,
        orderId: updated.id,
        kind: "advance_request",
        body: `To dispatch your order ${updated.name} please pay an advance of ${formatMoney(amount, updated.currency)}. The rest (${formatMoney(Number(updated.total) - amount, updated.currency)}) is paid on delivery.\n\n${instructions}`,
      });
    } else {
      const ctx = orderContext(store, updated, await getOrderItems(updated.id));
      ctx["advance.amount"] = formatMoney(amount, updated.currency);
      ctx["advance.instructions"] = instructions;
      await sendTemplate(store, { kind: "advance_payment", to: updated.phone_e164, ctx, orderId: updated.id, customerId: updated.customer_id, messageKind: "advance_request" });
    }
  }
  return updated;
}

export async function markAdvancePaid(store, orderId, { userId = null, source = "manual" } = {}) {
  const order = await getOrder(orderId);
  if (!order) return null;
  const updated = await setOrderStatus(order.id, order.status, { advance_status: "paid", advance_paid_at: new Date() });
  await queueTags(store, updated, { add: ["advancePaid"], remove: ["advanceRequested"] });
  await logOrderEvent(updated, `Advance marked paid (${source})`, { userId });
  if (store.settings.couriers.autoBook) await enqueue("shipment.book", { storeId: store.id, orderId: order.id, source: "advance" }, { singletonKey: `order:${order.id}:book` });
  await notify({ accountId: store.accountId, storeId: store.id, kind: "advance.paid", severity: "success", title: `Advance received for ${order.name}`, body: formatMoney(order.advance_amount, order.currency), link: `/orders/${order.id}` });
  if (updated.phone_e164) {
    const conversation = await upsertConversation(store.id, updated.phone_e164, { customerId: updated.customer_id });
    if (canMessageFreely(store, conversation)) {
      await sendText(store, { to: updated.phone_e164, conversation, orderId: updated.id, kind: "advance_ack", body: `Thank you! We received your advance for order ${updated.name} ✅ It will be dispatched soon.` }).catch(() => {});
    }
  }
  return updated;
}

export async function listBlocklist(accountId, { isSuperAdmin = false } = {}) {
  return many(
    `SELECT b.*, u.email AS created_by_email FROM blocklist b LEFT JOIN users u ON u.id=b.created_by
      WHERE b.account_id=$1 ${isSuperAdmin ? "OR b.account_id IS NULL" : ""} ORDER BY b.created_at DESC LIMIT 500`,
    [accountId]
  );
}

export async function unblock(accountId, id, { isSuperAdmin = false } = {}) {
  await query(`DELETE FROM blocklist WHERE id=$1 AND (account_id=$2 ${isSuperAdmin ? "OR account_id IS NULL" : ""})`, [id, accountId]);
}
