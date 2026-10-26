import { one, query } from "../db/pool.js";
import { PermanentError } from "../lib/errors.js";
import { toWaId } from "../lib/phone.js";
import { truncate } from "../lib/format.js";
import * as wa from "../whatsapp/cloudApi.js";
import { buildTemplatePayload, renderTemplateText } from "../whatsapp/templates.js";
import { sendViaGateway } from "../whatsapp/gateway.js";
import { toGatewayMessage, templateToGatewayMessage } from "../whatsapp/plain.js";
import { countUsage } from "./audit.js";
import { assertWithinPlan } from "./billing.js";

const WINDOW_MS = 24 * 3600 * 1000;

export async function upsertConversation(storeId, phone, { customerId, name } = {}) {
  return one(
    `INSERT INTO conversations (store_id, phone_e164, customer_id, name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (store_id, phone_e164) DO UPDATE
       SET customer_id = COALESCE(conversations.customer_id, EXCLUDED.customer_id),
           name = COALESCE(conversations.name, EXCLUDED.name)
     RETURNING *`,
    [storeId, phone, customerId ?? null, name ?? null]
  );
}

/** True when free-form messages may be sent (always for QR-linked numbers, which have no 24h rule). */
export function canMessageFreely(store, conversation) {
  return isGateway(store) || windowOpen(conversation);
}

export function windowOpen(conversation, now = Date.now()) {
  return !!conversation?.last_inbound_at && now - new Date(conversation.last_inbound_at).getTime() < WINDOW_MS;
}

const isGateway = (store) => store.wa?.provider === "gateway";

/**
 * Approved template for a kind, preferring the store language.
 * QR-linked numbers render templates locally, so Meta approval isn't needed there.
 */
export async function findTemplate(storeId, kind, language, { anyStatus = false } = {}) {
  return one(
    `SELECT * FROM templates WHERE store_id=$1 AND kind=$2 AND ($4 OR status='APPROVED')
     ORDER BY (status='APPROVED') DESC, (language = $3) DESC, updated_at DESC LIMIT 1`,
    [storeId, kind, language || "en", anyStatus]
  );
}

async function insertMessage(store, m) {
  return one(
    `INSERT INTO messages (store_id, conversation_id, order_id, customer_id, campaign_id, direction, kind, template_name,
                           category, wa_message_id, to_phone, body, media, payload, status, error_code, error_text,
                           cost_estimate, ai_generated, sent_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [
      store.id,
      m.conversationId ?? null,
      m.orderId ?? null,
      m.customerId ?? null,
      m.campaignId ?? null,
      m.direction,
      m.kind,
      m.templateName ?? null,
      m.category ?? null,
      m.waMessageId ?? null,
      m.to ?? null,
      m.body ?? null,
      m.media ?? null,
      m.payload ?? null,
      m.status,
      m.errorCode ?? null,
      m.errorText ?? null,
      m.cost ?? 0,
      !!m.aiGenerated,
      m.userId ?? null,
    ]
  );
}

async function touchConversation(conversationId, preview, { inbound = false } = {}) {
  await query(
    `UPDATE conversations SET last_message_at = now(), last_message_preview = $2,
       last_inbound_at = CASE WHEN $3 THEN now() ELSE last_inbound_at END,
       unread = CASE WHEN $3 THEN unread + 1 ELSE unread END,
       status = CASE WHEN $3 THEN 'open' ELSE status END
     WHERE id = $1`,
    [conversationId, truncate(preview || "", 120), inbound]
  );
}

function requireWa(store) {
  if (!store.wa) throw new PermanentError("No WhatsApp number linked to this store");
  if (isGateway(store) && !store.wa.gatewaySession) throw new PermanentError("The QR-linked WhatsApp session is missing. Scan the QR code again.");
  if (!store.active) throw new PermanentError("Store or account is not active");
}

// Owner reports and alerts keep working even when a plan runs out, so owners still hear about it.
const PLAN_EXEMPT = ["alert", "daily_report", "report"];

async function deliver(store, { to, payload, record, gateway }) {
  if (!PLAN_EXEMPT.includes(record.kind)) await assertWithinPlan(store.accountId, "messages");
  const conversation = record.conversation || (await upsertConversation(store.id, to, { customerId: record.customerId, name: record.name }));
  try {
    let wamid;
    if (isGateway(store)) {
      const plain = gateway || toGatewayMessage(payload, record.body);
      wamid = await sendViaGateway(store.wa.gatewaySession, toWaId(to), plain.message);
      // remember the numbered menu so a reply like "2" maps back to the right button
      await query(
        `UPDATE conversations SET state = (state - 'options') || CASE WHEN $2::jsonb = '[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('options', $2::jsonb) END WHERE id=$1`,
        [conversation.id, JSON.stringify(plain.options || [])]
      );
    } else {
      wamid = await wa.sendMessage(store.wa, toWaId(to), payload);
    }
    const msg = await insertMessage(store, {
      ...record,
      conversationId: conversation.id,
      direction: "out",
      to,
      waMessageId: wamid,
      payload,
      status: "sent",
    });
    await touchConversation(conversation.id, record.body);
    await countUsage(store.accountId, "messages");
    if (record.category === "marketing") await countUsage(store.accountId, "marketing_messages");
    return msg;
  } catch (err) {
    await insertMessage(store, {
      ...record,
      conversationId: conversation.id,
      direction: "out",
      to,
      payload,
      status: "failed",
      errorCode: err.code ? String(err.code) : null,
      errorText: err.message,
    });
    if (err.permanent) throw new PermanentError(err.message);
    throw err;
  }
}

/** Template language for a customer: their detected language (Urdu script -> "ur"), else the store default. */
async function customerLanguage(store, phone, customerId) {
  const c = customerId
    ? await one(`SELECT language FROM customers WHERE id=$1`, [customerId])
    : await one(`SELECT language FROM customers WHERE store_id=$1 AND phone_e164=$2 AND language IS NOT NULL LIMIT 1`, [store.id, phone]);
  const lang = String(c?.language || "");
  if (!lang || lang === "ur-Latn") return store.settings.language;
  return lang.split("-")[0] || store.settings.language;
}

/**
 * Sends the store's approved template for `kind` (or an explicit template row).
 * Marketing templates are only sent to opted-in customers when the store requires opt-in.
 */
export async function sendTemplate(store, { kind, template, to, ctx, orderId, customerId, campaignId, messageKind, name, skipOptInCheck = false }) {
  requireWa(store);
  if (!to) throw new PermanentError("No phone number");
  const tpl = template || (await findTemplate(store.id, kind, await customerLanguage(store, to, customerId), { anyStatus: isGateway(store) }));
  if (!tpl) throw new PermanentError(`No approved "${kind}" template for this store. Install templates under Templates.`);
  const category = String(tpl.category || "UTILITY").toLowerCase();
  if (category === "marketing" && !skipOptInCheck) await assertMarketingAllowed(store, to, customerId);
  const payload = isGateway(store) ? { type: "template", template: { name: tpl.name } } : buildTemplatePayload(tpl, ctx);
  return deliver(store, {
    to,
    payload,
    gateway: isGateway(store) ? templateToGatewayMessage(tpl, ctx) : undefined,
    record: {
      kind: messageKind || tpl.kind,
      templateName: tpl.name,
      category,
      body: renderTemplateText(tpl, ctx),
      orderId,
      customerId,
      campaignId,
      name,
      cost: Number(store.settings.pricing?.[category] || 0),
    },
  });
}

/**
 * Sends a free-form/interactive message. Only allowed within 24h of the customer's last message.
 */
export async function sendSession(store, { to, payload, body, kind, orderId, customerId, userId, aiGenerated, conversation }) {
  requireWa(store);
  const conv = conversation || (await upsertConversation(store.id, to, { customerId }));
  if (!isGateway(store) && !windowOpen(conv)) {
    throw new PermanentError("The 24-hour WhatsApp window is closed. Send an approved template instead.");
  }
  return deliver(store, {
    to,
    payload,
    record: { kind, category: "service", body, orderId, customerId, userId, aiGenerated, conversation: conv, cost: 0 },
  });
}

export const sendText = (store, opts) => sendSession(store, { ...opts, payload: wa.textPayload(opts.body) });

export async function assertMarketingAllowed(store, phone, customerId) {
  const c = customerId
    ? await one(`SELECT wa_opt_in, opted_out_at FROM customers WHERE id=$1`, [customerId])
    : await one(`SELECT wa_opt_in, opted_out_at FROM customers WHERE store_id=$1 AND phone_e164=$2 LIMIT 1`, [store.id, phone]);
  if (c?.opted_out_at) throw new PermanentError("Customer opted out of marketing messages");
  if (store.settings.marketing.requireOptIn && !c?.wa_opt_in) throw new PermanentError("Customer has not opted in to WhatsApp marketing");
}

export async function recordInbound(store, conversation, ev, { orderId, body } = {}) {
  const exists = ev.wamid ? await one(`SELECT id FROM messages WHERE wa_message_id=$1`, [ev.wamid]) : null;
  if (exists) return null; // duplicate delivery
  const msg = await insertMessage(store, {
    conversationId: conversation.id,
    customerId: conversation.customer_id,
    orderId,
    direction: "in",
    kind: "inbound",
    waMessageId: ev.wamid,
    to: conversation.phone_e164,
    body: body ?? ev.text ?? `[${ev.kind}]`,
    media: ev.media || (ev.location ? { location: ev.location } : null),
    payload: ev.payload ? { button: ev.payload } : null,
    status: "received",
  });
  await touchConversation(conversation.id, msg.body, { inbound: true });
  return msg;
}

const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };

/** Applies a delivery status webhook. Returns the updated message (with joins) or null. */
export async function applyStatus(ev) {
  const msg = await one(`SELECT * FROM messages WHERE wa_message_id=$1`, [ev.wamid]);
  if (!msg) return null;
  if (ev.status === "failed") {
    const e = ev.errors?.[0] || {};
    return one(
      `UPDATE messages SET status='failed', error_code=$2, error_text=$3, updated_at=now() WHERE id=$1 RETURNING *`,
      [msg.id, e.code ? String(e.code) : null, e.title || e.message || e.error_data?.details || "failed"]
    );
  }
  if ((RANK[ev.status] ?? -1) <= (RANK[msg.status] ?? -1)) return msg;
  return one(`UPDATE messages SET status=$2, updated_at=now() WHERE id=$1 RETURNING *`, [msg.id, ev.status]);
}
