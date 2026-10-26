/**
 * Automation rules ("IF this happens and these conditions match, THEN do these steps").
 * Steps run in order; a "wait" step pauses the rule and resumes it later through the job queue.
 */
import { one, many, query } from "../db/pool.js";
import { enqueue } from "../queue/queue.js";
import { formatMoney } from "../lib/format.js";
import { logger } from "../logger.js";
import { fillText } from "./settings.js";
import { getOrder, getOrderItems, queueTags, setOrderStatus } from "./orders.js";
import { sendText, sendTemplate, upsertConversation, canMessageFreely } from "./messaging.js";
import { orderContext } from "./context.js";
import { notify } from "./notifications.js";

export const TRIGGERS = {
  "order.created": "New order",
  "order.confirmed": "Order confirmed on WhatsApp",
  "order.cancelled": "Order cancelled",
  "order.no_response": "No reply to the confirmation",
  "shipment.delivered": "Parcel delivered",
  "shipment.failed": "Delivery attempt failed",
  "shipment.returned": "Parcel returned",
};

export const CONDITION_FIELDS = {
  total: { label: "Order total", type: "number" },
  is_cod: { label: "Cash on delivery", type: "boolean" },
  city: { label: "City", type: "text" },
  risk_score: { label: "Risk score", type: "number" },
  product: { label: "Product name", type: "text" },
  sku: { label: "Product SKU", type: "text" },
  item_count: { label: "Number of items", type: "number" },
  tag: { label: "Shopify tag", type: "text" },
  customer_orders: { label: "Customer's previous orders", type: "number" },
  discount_code: { label: "Discount code used", type: "text" },
};

export const STEP_TYPES = {
  send_text: "Send a WhatsApp message",
  send_template: "Send a template",
  add_tag: "Add a Shopify tag",
  remove_tag: "Remove a Shopify tag",
  notify: "Notify the team",
  assign: "Assign the chat to a teammate",
  needs_attention: "Mark as needs attention",
  book_courier: "Book the courier",
  request_advance: "Request an advance payment",
  cancel_order: "Cancel the order in Shopify",
  wait: "Wait",
};

async function factsFor(order) {
  const items = await getOrderItems(order.id);
  const prev = order.phone_e164
    ? await one(`SELECT count(*)::int AS n FROM orders WHERE store_id=$1 AND phone_e164=$2 AND id <> $3 AND shopify_created_at < $4`, [order.store_id, order.phone_e164, order.id, order.shopify_created_at])
    : { n: 0 };
  return {
    items,
    facts: {
      total: Number(order.total),
      is_cod: !!order.is_cod,
      city: order.shipping_address?.city || "",
      risk_score: Number(order.risk_score || 0),
      product: items.map((i) => i.title).join(" | "),
      sku: items.map((i) => i.sku || "").join(" | "),
      item_count: items.reduce((s, i) => s + Number(i.quantity || 0), 0),
      tag: (order.shopify_tags || []).join(" | "),
      customer_orders: prev.n,
      discount_code: (order.discount_codes || []).join(" | "),
    },
  };
}

export function matches(conditions, facts) {
  return (conditions || []).every((c) => {
    const actual = facts[c.field];
    const v = c.value;
    const text = String(actual ?? "").toLowerCase();
    const list = String(v ?? "")
      .toLowerCase()
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    switch (c.op) {
      case "eq":
        return typeof actual === "boolean" ? actual === (v === true || v === "true" || v === "yes") : typeof actual === "number" ? actual === Number(v) : text === String(v).toLowerCase();
      case "neq":
        return typeof actual === "number" ? actual !== Number(v) : text !== String(v).toLowerCase();
      case "gt":
        return Number(actual) > Number(v);
      case "gte":
        return Number(actual) >= Number(v);
      case "lt":
        return Number(actual) < Number(v);
      case "lte":
        return Number(actual) <= Number(v);
      case "contains":
        return list.some((x) => text.includes(x));
      case "not_contains":
        return !list.some((x) => text.includes(x));
      case "in":
        return list.includes(text);
      default:
        return false;
    }
  });
}

/** Run every active rule for this trigger. */
export async function runRules(store, order, trigger) {
  const rules = await many(`SELECT * FROM automation_rules WHERE store_id=$1 AND trigger=$2 AND active ORDER BY id`, [store.id, trigger]);
  if (!rules.length) return 0;
  const { facts } = await factsFor(order);
  let ran = 0;
  for (const rule of rules) {
    if (!matches(rule.conditions, facts)) continue;
    await query(`UPDATE automation_rules SET runs=runs+1, last_run_at=now() WHERE id=$1`, [rule.id]);
    await runSteps(store, rule, order.id, 0);
    ran++;
  }
  return ran;
}

/** Execute steps from `start`; returns when finished or paused by a wait step. */
export async function runSteps(store, rule, orderId, start = 0) {
  const steps = rule.steps || [];
  for (let i = start; i < steps.length; i++) {
    const step = steps[i];
    const order = await getOrder(orderId);
    if (!order) return;
    if (step.type === "wait") {
      const ms = Math.max(1, Number(step.hours || 1)) * 3600000;
      await enqueue("rule.continue", { storeId: store.id, ruleId: rule.id, orderId, step: i + 1 }, { delayMs: ms, singletonKey: `rule:${rule.id}:${orderId}:${i + 1}` });
      return;
    }
    try {
      await runStep(store, step, order, rule);
    } catch (err) {
      logger.warn({ rule: rule.id, step: step.type, err: err.message }, "automation rule step failed");
      await notify({ accountId: store.accountId, storeId: store.id, kind: "rule.failed", severity: "warning", title: `Rule "${rule.name}" step failed`, body: `${STEP_TYPES[step.type] || step.type}: ${err.message}`, link: `/orders/${order.id}` });
    }
  }
}

function vars(store, order) {
  return {
    name: order.first_name || order.customer_name || "there",
    order: order.name,
    total: formatMoney(order.total, order.currency),
    store: store.name,
    city: order.shipping_address?.city || "",
    phone: order.phone_e164 || "",
  };
}

async function runStep(store, step, order, rule) {
  switch (step.type) {
    case "send_text": {
      if (!order.phone_e164) return;
      const conversation = await upsertConversation(store.id, order.phone_e164, { customerId: order.customer_id });
      if (!canMessageFreely(store, conversation)) throw new Error("the 24-hour WhatsApp window is closed; use a template step instead");
      return sendText(store, { to: order.phone_e164, conversation, orderId: order.id, kind: "rule", body: fillText(step.text, vars(store, order)) });
    }
    case "send_template": {
      if (!order.phone_e164) return;
      const tpl = step.templateId ? await one(`SELECT * FROM templates WHERE id=$1 AND store_id=$2`, [step.templateId, store.id]) : null;
      const ctx = orderContext(store, order, await getOrderItems(order.id));
      return sendTemplate(store, { template: tpl || undefined, kind: tpl ? undefined : step.kind, to: order.phone_e164, ctx, orderId: order.id, customerId: order.customer_id, messageKind: "rule" });
    }
    case "add_tag":
      return queueTags(store, order, { add: [`=${fillText(step.tag, vars(store, order))}`] });
    case "remove_tag":
      return queueTags(store, order, { remove: [`=${step.tag}`] });
    case "notify":
      return notify({ accountId: store.accountId, storeId: store.id, userId: step.userId || null, kind: "rule", severity: step.severity || "info", title: fillText(step.title || rule.name, vars(store, order)), body: fillText(step.body || "", vars(store, order)) || null, link: `/orders/${order.id}` });
    case "assign": {
      if (!order.phone_e164) return;
      const conv = await upsertConversation(store.id, order.phone_e164, { customerId: order.customer_id });
      await query(`UPDATE conversations SET assigned_user_id=$2 WHERE id=$1`, [conv.id, step.userId || null]);
      if (step.userId) await notify({ accountId: store.accountId, storeId: store.id, userId: step.userId, kind: "inbox.assigned", title: `Chat assigned to you: ${order.customer_name || order.phone_e164}`, body: `Rule "${rule.name}" · order ${order.name}`, link: `/inbox/${conv.id}` });
      return;
    }
    case "needs_attention":
      return setOrderStatus(order.id, order.status, { needs_attention: true });
    case "book_courier":
      return enqueue("shipment.book", { storeId: store.id, orderId: order.id, courierId: step.courierId || null, source: "rule" }, { singletonKey: `order:${order.id}:book` });
    case "request_advance":
      return enqueue("advance.request", { storeId: store.id, orderId: order.id, amount: step.amount || null }, { singletonKey: `order:${order.id}:advance` });
    case "cancel_order":
      return enqueue("shopify.cancel", { storeId: store.id, orderId: order.id });
    default:
      throw new Error(`unknown step ${step.type}`);
  }
}
