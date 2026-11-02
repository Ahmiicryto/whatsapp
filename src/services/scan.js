/**
 * Warehouse / doorstep scanning: a barcode or QR (courier tracking number or order number)
 * finds the parcel, and the chosen action updates it in one step.
 */
import { one, many, query } from "../db/pool.js";
import { getStoreContext } from "./stores.js";
import { applyShipmentStatus } from "./shipments.js";

export const SCAN_ACTIONS = ["lookup", "dispatched", "delivered", "return_received"];

/** Tracking number, "#1042", "1042" or a Shopify order id -> { shipment, order } in the allowed stores. */
export async function findParcel(storeIds, rawCode) {
  const code = String(rawCode || "").trim();
  if (!code) return null;
  const lower = code.toLowerCase();
  let shipment = await one(
    `SELECT * FROM shipments WHERE store_id = ANY($1) AND lower(tracking_number) = $2 ORDER BY (status <> 'cancelled') DESC, id DESC LIMIT 1`,
    [storeIds, lower]
  );
  let order = shipment ? await one(`SELECT * FROM orders WHERE id=$1`, [shipment.order_id]) : null;
  if (!order) {
    const name = code.startsWith("#") ? code : `#${code}`;
    order = await one(
      `SELECT * FROM orders WHERE store_id = ANY($1) AND (name = $2 OR name = $3 OR ($4 ~ '^[0-9]{6,}$' AND shopify_order_id::text = $4)) ORDER BY shopify_created_at DESC LIMIT 1`,
      [storeIds, code, name, code]
    );
    if (order) shipment = await one(`SELECT * FROM shipments WHERE order_id=$1 ORDER BY (status <> 'cancelled') DESC, id DESC LIMIT 1`, [order.id]);
  }
  return order ? { order, shipment } : null;
}

async function parcelView(found) {
  const { order, shipment } = found;
  const items = await many(`SELECT title, variant_title, quantity, image_url, sku FROM order_items WHERE order_id=$1 ORDER BY id`, [order.id]);
  return {
    order: { id: order.id, name: order.name, status: order.status, customer_name: order.customer_name, phone: order.phone_e164, city: order.shipping_address?.city || null, total: Number(order.total), currency: order.currency, is_cod: order.is_cod, store_id: order.store_id },
    shipment: shipment
      ? { id: shipment.id, courier: shipment.courier_name, tracking_number: shipment.tracking_number, status: shipment.status, cod_amount: Number(shipment.cod_amount), return_received_at: shipment.return_received_at, dispatched_at: shipment.dispatched_at, delivered_at: shipment.delivered_at }
      : null,
    items,
  };
}

/** Look up (and optionally act on) a scanned code. Every scan is logged. */
export async function scanParcel({ storeIds, code, action = "lookup", userId }) {
  const found = await findParcel(storeIds, code);
  const log = (storeId, result, f) =>
    query(`INSERT INTO parcel_scans (store_id, shipment_id, order_id, code, action, result, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      storeId,
      f?.shipment?.id || null,
      f?.order?.id || null,
      String(code).slice(0, 120),
      action,
      result,
      userId || null,
    ]);
  if (!found) {
    if (storeIds[0]) await log(storeIds[0], "not_found", null);
    return { result: "not_found", message: `Nothing found for "${code}"` };
  }
  const store = await getStoreContext(found.order.store_id);
  let { shipment } = found;
  let result = "ok";
  let message = "Found";
  const by = "Scanned in the warehouse";
  if (action !== "lookup") {
    if (!shipment) {
      result = "error";
      message = `Order ${found.order.name} has no shipment yet. Book it first.`;
    } else if (action === "dispatched") {
      if (shipment.dispatched_at || !["booked"].includes(shipment.status)) [result, message] = ["already", `Already ${shipment.status.replace(/_/g, " ")}`];
      else {
        shipment = await applyShipmentStatus(store, shipment, "in_transit", { raw: `Handed to ${shipment.courier_name || "courier"} (scanned)`, source: "scan" });
        shipment = await one(`UPDATE shipments SET dispatched_at=now() WHERE id=$1 RETURNING *`, [shipment.id]);
        message = "Marked handed to the courier";
      }
    } else if (action === "delivered") {
      if (shipment.status === "delivered") [result, message] = ["already", "Already delivered"];
      else {
        shipment = await applyShipmentStatus(store, shipment, "delivered", { raw: by, source: "scan" });
        message = `Delivered · ${shipment.cod_amount > 0 ? "cash to collect from courier" : "prepaid"}`;
      }
    } else if (action === "return_received") {
      if (shipment.return_received_at) [result, message] = ["already", "This return was already received"];
      else {
        if (shipment.status !== "returned") shipment = await applyShipmentStatus(store, shipment, "returned", { raw: "Return received at warehouse (scanned)", source: "scan" });
        shipment = await one(`UPDATE shipments SET return_received_at=now() WHERE id=$1 RETURNING *`, [shipment.id]);
        message = "Return received. Check the items and restock them in Shopify.";
      }
    }
  }
  await log(found.order.store_id, result, { ...found, shipment });
  return { result, message, action, ...(await parcelView({ order: found.order, shipment })) };
}

export async function recentScans(storeIds, { limit = 30 } = {}) {
  return many(
    `SELECT ps.*, o.name AS order_name, o.customer_name, sh.tracking_number, sh.status AS shipment_status, u.name AS user_name
       FROM parcel_scans ps LEFT JOIN orders o ON o.id=ps.order_id LEFT JOIN shipments sh ON sh.id=ps.shipment_id LEFT JOIN users u ON u.id=ps.user_id
      WHERE ps.store_id = ANY($1) ORDER BY ps.created_at DESC LIMIT ${Number(limit)}`,
    [storeIds]
  );
}

export async function scanSummary(storeIds) {
  return one(
    `SELECT count(*) FILTER (WHERE action='return_received' AND result='ok')::int AS returns_today,
            count(*) FILTER (WHERE action='delivered' AND result='ok')::int AS delivered_today,
            count(*) FILTER (WHERE action='dispatched' AND result='ok')::int AS dispatched_today,
            count(*)::int AS scans_today
       FROM parcel_scans WHERE store_id = ANY($1) AND created_at > date_trunc('day', now())`,
    [storeIds]
  );
}
