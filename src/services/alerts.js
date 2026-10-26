import { one, many } from "../db/pool.js";
import { enqueue } from "../queue/queue.js";
import { sendTemplate } from "./messaging.js";
import { logger } from "../logger.js";
import { notify } from "./notifications.js";

const ALERT_TITLES = {
  high_risk: "High-risk order",
  high_value: "High-value order",
  failed_spike: "Messages are failing",
  low_confirmation: "Low confirmation rate",
  uninstalled: "Shopify app uninstalled",
  gateway_logout: "WhatsApp was logged out",
  quality: "WhatsApp quality dropped",
};
const ALERT_LINKS = {
  high_risk: () => "/orders?filter=attention",
  gateway_logout: (s) => `/stores/${s.id}?tab=whatsapp`,
  uninstalled: (s) => `/stores/${s.id}`,
  quality: (s) => `/stores/${s.id}?tab=whatsapp`,
};

/** Records an alert once per dedupe key and queues WhatsApp notifications to owner numbers. */
export async function raiseAlert(store, kind, dedupeKey, message) {
  const row = await one(
    `INSERT INTO alerts (account_id, store_id, kind, dedupe_key, message) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [store.accountId, store.id, kind, dedupeKey, message]
  );
  if (!row) return false;
  await notify({ accountId: store.accountId, storeId: store.id, kind: `alert.${kind}`, severity: ["high_value"].includes(kind) ? "success" : "warning", title: ALERT_TITLES[kind] || "Store alert", body: message, link: ALERT_LINKS[kind]?.(store) || null });
  await enqueue("alert.send", { storeId: store.id, alertId: row.id });
  return true;
}

export async function ownerContactsFor(store, reportType) {
  return many(
    `SELECT * FROM owner_contacts
      WHERE account_id=$1 AND enabled AND (store_id=$2 OR store_id IS NULL) AND $3 = ANY(reports)`,
    [store.accountId, store.id, reportType]
  );
}

export async function sendAlert(store, alertId) {
  const alert = await one(`SELECT * FROM alerts WHERE id=$1`, [alertId]);
  if (!alert) return;
  const contacts = await ownerContactsFor(store, "alerts");
  for (const c of contacts) {
    try {
      await sendTemplate(store, {
        kind: "owner_alert",
        to: c.phone_e164,
        ctx: { "alert.store": store.name, "alert.text": alert.message },
        messageKind: "alert",
        name: c.name,
      });
    } catch (err) {
      logger.warn({ err: err.message, contact: c.id }, "owner alert send failed");
    }
  }
}
