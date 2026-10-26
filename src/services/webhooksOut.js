/**
 * Outgoing webhooks: merchants register URLs under Developers and receive signed JSON events
 * (X-WA-Signature: hex HMAC-SHA256 of the raw body with the endpoint secret).
 */
import { many, query, one } from "../db/pool.js";
import { enqueue } from "../queue/queue.js";
import { decrypt, hmacHex } from "../lib/crypto.js";
import { requestJson } from "../lib/http.js";

export const WEBHOOK_EVENTS = [
  "order.created",
  "order.confirmed",
  "order.cancelled",
  "order.no_response",
  "shipment.booked",
  "shipment.updated",
  "message.received",
  "review.created",
  "notification.created",
];

/** Queue one delivery per endpoint subscribed to the event. */
export async function emitEvent({ accountId, event, data }) {
  if (!accountId) return 0;
  const endpoints = await many(
    `SELECT id FROM webhook_endpoints WHERE account_id=$1 AND active AND ($2 = ANY(events) OR '*' = ANY(events))`,
    [accountId, event]
  );
  for (const e of endpoints) {
    await enqueue("webhooks.deliver", { endpointId: e.id, event, data, at: new Date().toISOString() }, { maxAttempts: 6 });
  }
  return endpoints.length;
}

export async function deliverWebhook({ endpointId, event, data, at }) {
  const ep = await one(`SELECT * FROM webhook_endpoints WHERE id=$1 AND active`, [endpointId]);
  if (!ep) return;
  const body = JSON.stringify({ event, created_at: at, data });
  const sig = hmacHex(decrypt(ep.secret_enc), body);
  let status = 0;
  let error = null;
  try {
    const res = await requestJson(ep.url, { method: "POST", headers: { "Content-Type": "application/json", "X-WA-Event": event, "X-WA-Signature": sig }, body, timeoutMs: 10000 });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err.message;
  }
  await query(`UPDATE webhook_endpoints SET last_status=$2, last_error=$3, last_sent_at=now() WHERE id=$1`, [ep.id, status || null, error]);
  if (error) throw new Error(`webhook ${ep.url} failed: ${error}`); // retried with backoff by the queue
}
