/**
 * Courier shipments: booking, live tracking, failed-delivery recovery and COD settlement.
 * Shipment status changes drive the customer's WhatsApp updates and the merchant's notifications.
 */
import { one, many, query } from "../db/pool.js";
import { enqueue } from "../queue/queue.js";
import { PermanentError } from "../lib/errors.js";
import { formatMoney, itemsSummary } from "../lib/format.js";
import { logger } from "../logger.js";
import { PROVIDERS, courierById, loadCourier, normalizeStatus, FINAL_STATUSES } from "../couriers/index.js";
import { localPhone } from "../couriers/common.js";
import { getOrder, getOrderItems, setOrderStatus, queueTags, logOrderEvent } from "./orders.js";
import { orderContext } from "./context.js";
import { sendTemplate } from "./messaging.js";
import { createShortLink } from "./links.js";
import { notify } from "./notifications.js";
import { isBlocked, autoBlockCheck } from "./fraud.js";
import { orderEvent } from "./events.js";
import { emitEvent } from "./webhooksOut.js";

const CLOSED_ORDER = ["cancelled", "cancelled_by_customer", "returned"];

export async function activeShipmentFor(orderId) {
  return one(`SELECT * FROM shipments WHERE order_id=$1 AND status <> 'cancelled' ORDER BY id DESC LIMIT 1`, [orderId]);
}

/** Book an order with a courier (the store's default unless `courierId` is given). Idempotent per order. */
export async function bookShipment(store, orderId, { courierId, weightKg, trackingNumber, notes, userId, force = false } = {}) {
  const order = await getOrder(orderId);
  if (!order || order.store_id !== store.id) throw new PermanentError("Order not found");
  if (CLOSED_ORDER.includes(order.status)) throw new PermanentError(`Order ${order.name} is ${order.status.replace(/_/g, " ")}`);
  const existing = await activeShipmentFor(order.id);
  if (existing) return existing;
  if (order.advance_status === "requested" && !force) throw new PermanentError(`Order ${order.name} is waiting for its advance payment`);
  if (!force && (await isBlocked(store.accountId, order.phone_e164))) throw new PermanentError(`${order.phone_e164} is on your blocklist`);
  const courier = await courierById(store.id, courierId);
  if (!courier) throw new PermanentError("Add a courier first: Store → Couriers");

  const items = await getOrderItems(order.id);
  const a = order.shipping_address || {};
  const advance = order.advance_status === "paid" ? Number(order.advance_amount || 0) : 0;
  const cod = order.is_cod ? Math.max(0, Number(order.total) - advance) : 0;
  const pieces = Math.max(1, items.reduce((s, i) => s + Number(i.quantity || 0), 0));
  const kg = Number(weightKg || store.settings.couriers.defaultWeightKg || 0.5);
  const address = [a.address1, a.address2].filter(Boolean).join(", ") || order.address_text || "";
  const city = a.city || "";
  const description = itemsSummary(items, order.currency, 240);
  const input = {
    ref: String(order.name).replace(/^#/, ""),
    name: order.customer_name || a.name || "Customer",
    phone: order.phone_e164,
    email: order.email,
    address,
    city,
    codAmount: cod,
    pieces,
    weightKg: kg,
    description,
    notes,
    trackingNumber,
  };
  input.vars = {
    ref: input.ref,
    name: input.name,
    phone: input.phone || "",
    phone_local: localPhone(input.phone),
    email: input.email || "",
    address,
    city,
    cod: String(Math.round(cod)),
    pieces: String(pieces),
    weight_kg: String(kg),
    description,
    notes: notes || "",
  };

  let result;
  try {
    result = await courier.provider.book(courier, input);
  } catch (err) {
    await notify({ accountId: store.accountId, storeId: store.id, kind: "shipment.book_failed", severity: "danger", title: `${courier.row.name} booking failed for ${order.name}`, body: err.message, link: `/orders/${order.id}` });
    throw new PermanentError(err.message);
  }
  const tn = result.trackingNumber || null;
  const shipment = await one(
    `INSERT INTO shipments (store_id, order_id, courier_id, provider, courier_name, tracking_number, tracking_url, label_url, cod_amount, weight_kg, events)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [store.id, order.id, courier.row.id, courier.row.provider, courier.row.name, tn, tn ? courier.provider.trackingUrl?.(tn, courier) || null : null, result.labelUrl || null, cod, kg, JSON.stringify([{ status: "Booked", at: new Date().toISOString() }])]
  );
  await queueTags(store, order, { add: ["booked"] });
  if (order.status === "confirmed" || order.status === "new" || order.status === "awaiting_reply") await setOrderStatus(order.id, "fulfilled");
  await logOrderEvent(order, `Booked with ${courier.row.name} (${tn || "no tracking number yet"})`, { userId });
  const s = store.settings.couriers;
  if (tn && s.fulfillInShopify && store.shopifyToken) await enqueue("shipment.fulfill", { storeId: store.id, shipmentId: shipment.id });
  if (tn && s.notifyOnBooking && store.settings.tracking.enabled) {
    await enqueue("shipment.notify", { storeId: store.id, shipmentId: shipment.id, event: "shipped" }, { singletonKey: `shipment:${shipment.id}:shipped` });
  }
  await emitEvent({ accountId: store.accountId, event: "shipment.booked", data: publicShipment(shipment, order) });
  return shipment;
}

export function publicShipment(s, order) {
  return {
    id: s.id,
    order_id: s.order_id,
    order_name: order?.name,
    courier: s.courier_name,
    provider: s.provider,
    tracking_number: s.tracking_number,
    tracking_url: s.tracking_url,
    status: s.status,
    status_raw: s.status_raw,
    cod_amount: Number(s.cod_amount),
    booked_at: s.booked_at,
    delivered_at: s.delivered_at,
    returned_at: s.returned_at,
    cod_settled_at: s.cod_settled_at,
  };
}

const REASON = {
  attempted: "nobody was available to receive it",
  refused: "the parcel was refused",
};

/** WhatsApp update to the customer for a shipment event. */
export async function notifyShipment(store, shipmentId, event) {
  const sh = await one(`SELECT * FROM shipments WHERE id=$1`, [shipmentId]);
  if (!sh) return;
  const order = await getOrder(sh.order_id);
  if (!order?.phone_e164 || ["cancelled", "cancelled_by_customer"].includes(order.status)) return;
  const notified = sh.notified || {};
  const key = event === "failed" ? `failed${sh.attempts}` : event;
  if (notified[key]) return;
  const items = await getOrderItems(order.id);
  const ctx = orderContext(store, order, items);
  ctx["tracking.company"] = sh.courier_name || "our courier";
  ctx["tracking.number"] = sh.tracking_number || "-";
  const kinds = { shipped: "order_shipped", out_for_delivery: "out_for_delivery", delivered: "order_delivered", failed: "delivery_failed" };
  if (event === "shipped") {
    ctx["link.code"] = await createShortLink({ storeId: store.id, targetUrl: sh.tracking_url || order.order_status_url || `https://${store.shopifyDomain}`, kind: "tracking", orderId: order.id });
  }
  if (event === "out_for_delivery" && sh.cod_amount !== null) {
    ctx["order.amount_due"] = Number(sh.cod_amount) > 0 ? `${formatMoney(sh.cod_amount, order.currency)} (Cash on Delivery)` : "nothing, it is already paid";
  }
  if (event === "failed") ctx["shipment.reason"] = REASON[sh.status] || sh.status_raw || "the delivery attempt failed";
  await sendTemplate(store, { kind: kinds[event], to: order.phone_e164, ctx, orderId: order.id, customerId: order.customer_id, messageKind: event === "failed" ? "delivery_failed" : event === "shipped" ? "tracking" : event });
  notified[key] = true;
  await query(`UPDATE shipments SET notified=$2, updated_at=now() WHERE id=$1`, [sh.id, notified]);
  if (event === "shipped") await queueTags(store, order, { add: ["trackingSent"] });
}

/** Apply a (normalized) status from tracking, a manual update or a CSV import, and react to the change. */
export async function applyShipmentStatus(store, sh, status, { raw = null, events = null, fee, source = "tracking" } = {}) {
  const changed = status !== sh.status;
  const sets = ["status=$2", "status_raw=COALESCE($3, status_raw)", "last_checked_at=now()", "updated_at=now()"];
  const params = [sh.id, status, raw];
  if (events?.length) {
    params.push(JSON.stringify(events));
    sets.push(`events=$${params.length}`);
  }
  if (fee !== undefined && fee !== null && !Number.isNaN(Number(fee))) {
    params.push(Number(fee));
    sets.push(`fee=$${params.length}`);
  }
  if (changed && status === "delivered") sets.push("delivered_at=now()");
  if (changed && status === "returned") sets.push("returned_at=now()");
  if (changed && ["attempted", "refused"].includes(status)) sets.push("attempts=attempts+1");
  const updated = await one(`UPDATE shipments SET ${sets.join(", ")} WHERE id=$1 RETURNING *`, params);
  if (!changed) return updated;

  const order = await getOrder(sh.order_id);
  const t = store.settings.tracking;
  logger.info({ shipment: sh.id, from: sh.status, to: status, source }, "shipment status changed");
  switch (status) {
    case "out_for_delivery":
      if (t.enabled && t.outForDelivery) await enqueue("shipment.notify", { storeId: store.id, shipmentId: sh.id, event: "out_for_delivery" }, { singletonKey: `shipment:${sh.id}:ofd` });
      break;
    case "delivered":
      await setOrderStatus(order.id, "delivered");
      await queueTags(store, order, { add: ["delivered"], remove: ["reschedule"] });
      if (t.enabled && t.delivered) await enqueue("shipment.notify", { storeId: store.id, shipmentId: sh.id, event: "delivered" }, { singletonKey: `shipment:${sh.id}:delivered` });
      await orderEvent(store, order, "shipment.delivered");
      break;
    case "attempted":
    case "refused": {
      const r = store.settings.recovery;
      if (r.enabled && updated.attempts <= Number(r.maxMessages || 2)) {
        await enqueue("shipment.notify", { storeId: store.id, shipmentId: sh.id, event: "failed" }, { singletonKey: `shipment:${sh.id}:failed:${updated.attempts}` });
      }
      await setOrderStatus(order.id, order.status, { needs_attention: true });
      await notify({ accountId: store.accountId, storeId: store.id, kind: "shipment.failed", severity: "warning", title: `Delivery ${status === "refused" ? "refused" : "failed"}: ${order.name}`, body: `${sh.courier_name}: ${raw || status}. ${r.enabled ? "The customer was asked on WhatsApp what to do." : ""}`, link: `/orders/${order.id}` });
      await orderEvent(store, order, "shipment.failed", { key: String(updated.attempts) });
      break;
    }
    case "returned":
      await setOrderStatus(order.id, "returned", { needs_attention: false });
      await queueTags(store, order, { add: ["returned"] });
      await notify({ accountId: store.accountId, storeId: store.id, kind: "shipment.returned", severity: "danger", title: `Parcel returned: ${order.name}`, body: `${order.customer_name || ""} ${order.phone_e164 || ""}`.trim(), link: `/orders/${order.id}` });
      await autoBlockCheck(store, order);
      await orderEvent(store, order, "shipment.returned");
      break;
    default:
      break;
  }
  await emitEvent({ accountId: store.accountId, event: "shipment.updated", data: publicShipment(updated, order) });
  return updated;
}

/** Ask the courier for the latest status. */
export async function syncShipment(store, shipmentId) {
  const sh = await one(`SELECT * FROM shipments WHERE id=$1`, [shipmentId]);
  if (!sh || !sh.tracking_number || FINAL_STATUSES.includes(sh.status)) return sh;
  const row = sh.courier_id ? await one(`SELECT * FROM store_couriers WHERE id=$1`, [sh.courier_id]) : null;
  if (!row) return sh;
  const courier = loadCourier(row);
  const r = await courier.provider.track(courier, sh.tracking_number);
  if (!r) {
    await query(`UPDATE shipments SET last_checked_at=now() WHERE id=$1`, [sh.id]);
    return sh;
  }
  return applyShipmentStatus(store, sh, normalizeStatus(r.statusRaw), { raw: r.statusRaw, events: r.events, fee: r.fee });
}

/** Every 2 hours: queue a status check for shipments still on the road. */
export async function queueShipmentSync() {
  const rows = await many(
    `SELECT sh.id, sh.store_id FROM shipments sh JOIN store_couriers c ON c.id=sh.courier_id
      WHERE sh.status NOT IN ('delivered','returned','cancelled') AND sh.tracking_number IS NOT NULL AND c.provider <> 'manual'
        AND (sh.last_checked_at IS NULL OR sh.last_checked_at < now() - interval '90 minutes') AND sh.booked_at > now() - interval '45 days'
      ORDER BY sh.last_checked_at NULLS FIRST LIMIT 2000`
  );
  for (const r of rows) await enqueue("shipment.sync", { storeId: r.store_id, shipmentId: r.id }, { singletonKey: `shipment:${r.id}:sync`, maxAttempts: 2 });
  return rows.length;
}

/** Customer answered the failed-delivery message. */
export async function customerRecoveryChoice(store, order, choice) {
  const sh = await activeShipmentFor(order.id);
  if (!sh) return null;
  const reschedule = { choice, at: new Date().toISOString() };
  await query(`UPDATE shipments SET reschedule=$2, updated_at=now() WHERE id=$1`, [sh.id, reschedule]);
  if (choice === "redeliver") await queueTags(store, order, { add: ["reschedule"] });
  await notify({
    accountId: store.accountId,
    storeId: store.id,
    kind: "shipment.recovery",
    severity: choice === "cancel" ? "danger" : "info",
    title: choice === "cancel" ? `${order.name}: customer wants to cancel` : `${order.name}: customer asked to deliver again`,
    body: `${sh.courier_name} ${sh.tracking_number || ""}. Ask the courier to ${choice === "cancel" ? "return the parcel" : "re-attempt delivery"}.`,
    link: `/orders/${order.id}`,
  });
  return sh;
}

/** Shopify fulfillment with the tracking number (best effort). */
export async function fulfillInShopify(store, shipmentId, fulfillOrder) {
  const sh = await one(`SELECT * FROM shipments WHERE id=$1`, [shipmentId]);
  const order = sh && (await getOrder(sh.order_id));
  if (!sh?.tracking_number || !order) return;
  // Needs a fulfillment write permission, which stores only have if it was added to SHOPIFY_SCOPES (optional).
  const row = await one(`SELECT shopify_scopes FROM stores WHERE id=$1`, [store.id]);
  if (row?.shopify_scopes && !/write_(merchant_managed|third_party|assigned)_fulfillment_orders|write_fulfillments/.test(row.shopify_scopes)) return;
  try {
    await fulfillOrder(store, order.shopify_order_id, { company: sh.courier_name, number: sh.tracking_number, url: sh.tracking_url });
  } catch (err) {
    logger.warn({ err: err.message, shipment: sh.id }, "could not mark the order fulfilled in Shopify (missing permission?)");
  }
}

/** Mark delivered parcels' cash as received from the courier. */
export async function settleShipments(storeIds, ids, ref) {
  const rows = await many(
    `UPDATE shipments SET cod_settled_at=now(), settlement_ref=$3, updated_at=now()
      WHERE id = ANY($1) AND store_id = ANY($2) AND cod_settled_at IS NULL RETURNING id, cod_amount`,
    [ids, storeIds, ref || null]
  );
  return { count: rows.length, amount: rows.reduce((s, r) => s + Number(r.cod_amount), 0) };
}

/**
 * Courier CSV import: tracking number + optional status and/or settled amount per row.
 * Rows: [{ tracking, status?, amount?, ref? }]. Returns counts and unmatched tracking numbers.
 */
export async function importShipmentCsv(storeIds, rows, getStore) {
  const out = { updated: 0, settled: 0, amount: 0, unmatched: [] };
  for (const r of rows) {
    const tn = String(r.tracking || "").trim();
    if (!tn) continue;
    const sh = await one(`SELECT * FROM shipments WHERE tracking_number=$1 AND store_id = ANY($2) ORDER BY id DESC LIMIT 1`, [tn, storeIds]);
    if (!sh) {
      out.unmatched.push(tn);
      continue;
    }
    if (r.status) {
      const store = await getStore(sh.store_id);
      await applyShipmentStatus(store, sh, normalizeStatus(r.status), { raw: r.status, source: "csv" });
      out.updated++;
    }
    if (r.amount !== undefined && r.amount !== "" && !sh.cod_settled_at) {
      await query(`UPDATE shipments SET cod_settled_at=now(), settlement_ref=$2, updated_at=now() WHERE id=$1`, [sh.id, r.ref || "CSV import"]);
      out.settled++;
      out.amount += Number(r.amount || sh.cod_amount);
    }
  }
  return out;
}

/** Tiny CSV parser (quoted fields, commas, CRLF). First row = headers. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => headers.findIndex((h) => names.some((n) => h.includes(n)));
  const ti = col("tracking", "cn", "consignment");
  const si = col("status");
  const ai = col("amount", "cod", "collected");
  const ri = col("ref", "invoice", "payment");
  return rows.slice(1).map((r) => ({
    tracking: ti >= 0 ? r[ti] : r[0],
    status: si >= 0 ? r[si] : undefined,
    amount: ai >= 0 ? r[ai]?.replace(/[^\d.]/g, "") : undefined,
    ref: ri >= 0 ? r[ri] : undefined,
  }));
}

export const providerName = (id) => PROVIDERS[id]?.name || id;
