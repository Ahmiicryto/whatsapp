import { one, many, query } from "../db/pool.js";
import { fromWaId } from "../lib/phone.js";
import { formatMoney } from "../lib/format.js";
import { logger } from "../logger.js";
import * as wa from "../whatsapp/cloudApi.js";
import { matchOption } from "../whatsapp/plain.js";
import { aiAvailable, transcribe } from "../ai/provider.js";
import { detectIntent, keywordIntent, agentReply } from "../ai/features.js";
import { getStoreContext, invalidateStore } from "./stores.js";
import { upsertConversation, recordInbound, sendText, applyStatus, windowOpen, canMessageFreely } from "./messaging.js";
import { getOrder, queueTags, setOrderStatus } from "./orders.js";
import * as flow from "./confirmation.js";
import { raiseAlert } from "./alerts.js";

const OPEN_STATUSES = ["new", "awaiting_reply", "no_response", "confirmed"];

/** Several stores may share one number: pick the store this customer is talking to. */
async function routeStore(phoneNumberId, phone, payload) {
  const stores = await many(
    `SELECT s.id FROM stores s JOIN whatsapp_numbers w ON w.id = s.whatsapp_number_id WHERE w.phone_number_id=$1`,
    [phoneNumberId]
  );
  if (!stores.length) return null;
  if (stores.length === 1) return stores[0].id;
  const ids = stores.map((s) => s.id);
  const ref = payload?.split(":")[1];
  if (ref && /^\d+$/.test(ref)) {
    const o = await one(`SELECT store_id FROM orders WHERE id=$1 AND store_id = ANY($2)`, [ref, ids]);
    if (o) return o.store_id;
  }
  const recent = await one(
    `SELECT store_id FROM (
       SELECT store_id, shopify_created_at AS at FROM orders WHERE phone_e164=$1 AND store_id = ANY($2)
       UNION ALL SELECT store_id, last_message_at FROM conversations WHERE phone_e164=$1 AND store_id = ANY($2)
     ) x ORDER BY at DESC NULLS LAST LIMIT 1`,
    [phone, ids]
  );
  return recent?.store_id || ids[0];
}

async function latestOpenOrder(storeId, phone) {
  return one(
    `SELECT * FROM orders WHERE store_id=$1 AND phone_e164=$2 AND status = ANY($3)
     ORDER BY shopify_created_at DESC LIMIT 1`,
    [storeId, phone, OPEN_STATUSES]
  );
}

async function orderForStore(store, ref) {
  if (!ref || !/^\d+$/.test(ref)) return null;
  const order = await getOrder(ref);
  return order && order.store_id === store.id ? order : null;
}

export async function handleMessageEvent(ev) {
  const phone = fromWaId(ev.from);
  const storeId = await routeStore(ev.phoneNumberId, phone, ev.payload);
  if (!storeId) {
    logger.warn({ phoneNumberId: ev.phoneNumberId }, "inbound message for unknown number");
    return;
  }
  const store = await getStoreContext(storeId);
  if (!store?.wa) return;
  const customer = await one(`SELECT * FROM customers WHERE store_id=$1 AND phone_e164=$2 ORDER BY last_order_at DESC NULLS LAST LIMIT 1`, [store.id, phone]);
  let conversation = await upsertConversation(store.id, phone, { customerId: customer?.id, name: ev.profileName });

  let text = ev.text || "";
  let recordBody;
  if (ev.kind === "audio" && (ev.media?.id || ev.media?.base64) && store.settings.ai.voiceNotes && aiAvailable(store)) {
    try {
      const media = ev.media.base64
        ? { buffer: Buffer.from(ev.media.base64, "base64"), mime: ev.media.mime } // sent along by the QR gateway
        : await wa.downloadMedia(store.wa, ev.media.id);
      text = await transcribe(store, media.buffer, media.mime);
      recordBody = `🎤 ${text}`;
    } catch (err) {
      logger.warn({ err: err.message }, "voice note transcription failed");
      recordBody = "🎤 Voice note";
    }
  }
  if (ev.kind === "location") recordBody = `📍 ${ev.location?.address || ev.location?.name || `${ev.location?.lat}, ${ev.location?.lng}`}`;

  const msg = await recordInbound(store, conversation, ev, { body: recordBody });
  if (!msg) return; // duplicate webhook
  if (store.wa.provider !== "gateway") wa.markRead(store.wa, ev.wamid);
  conversation = await one(`SELECT * FROM conversations WHERE id=$1`, [conversation.id]);

  // QR-linked numbers send numbered menus instead of buttons: "2" -> the second button's payload.
  if (!ev.payload) {
    const picked = matchOption(text, conversation.state?.options);
    if (picked) ev.payload = picked;
  }

  if (ev.payload) return handlePayload(store, conversation, ev.payload, customer, text);

  const state = conversation.state || {};
  if (state.mode === "awaiting_address" && (ev.location || text)) {
    const kw = keywordIntent(text);
    const order = await orderForStore(store, String(state.orderId));
    if (order && kw.intent !== "opt_out" && kw.intent !== "cancel") {
      return flow.receiveAddress(store, order, conversation, { text, location: ev.location });
    }
  }

  const pending = await latestOpenOrder(store.id, phone);
  if (ev.location) {
    if (pending) {
      await query(`UPDATE conversations SET state=$2 WHERE id=$1`, [conversation.id, { mode: "awaiting_address", orderId: pending.id }]);
      return flow.receiveAddress(store, pending, conversation, { location: ev.location });
    }
    return;
  }
  if (!text.trim()) {
    await query(`UPDATE conversations SET needs_human=true WHERE id=$1`, [conversation.id]);
    return;
  }

  let intent = keywordIntent(text);
  if (store.settings.ai.intent && aiAvailable(store)) {
    try {
      const context = pending
        ? `Customer has order ${pending.name} (${formatMoney(pending.total, pending.currency)}) with status "${pending.status}"${pending.status === "awaiting_reply" ? " waiting for their confirmation" : ""}.`
        : "Customer has no open order.";
      intent = await detectIntent(store, { text, context });
    } catch (err) {
      logger.warn({ err: err.message }, "AI intent failed, using keywords");
    }
  }
  const confident = intent.confidence >= Number(store.settings.ai.minConfidence || 0.6);
  const kind = confident ? intent.intent : "other";

  switch (kind) {
    case "opt_out":
      await flow.setOptIn(conversation.customer_id || customer?.id, false);
      return sendText(store, { to: phone, conversation, kind: "opt_out_ack", body: "You have been unsubscribed from offers. You'll still receive updates about your orders." });
    case "confirm":
      if (pending && ["awaiting_reply", "no_response", "new"].includes(pending.status)) return flow.confirmOrder(store, pending, conversation);
      break;
    case "cancel":
      if (pending && pending.status !== "confirmed") return flow.requestCancel(store, pending, conversation);
      if (pending) {
        // confirmed orders may already be packed: let a human decide
        await query(`UPDATE conversations SET needs_human=true WHERE id=$1`, [conversation.id]);
        await setOrderStatus(pending.id, pending.status, { needs_attention: true });
        return sendText(store, { to: phone, conversation, orderId: pending.id, kind: "agent", body: `We've received your request to cancel order ${pending.name}. Our team will get back to you shortly.` });
      }
      break;
    case "change_address":
      if (pending) {
        if (intent.address_text) {
          await query(`UPDATE conversations SET state=$2 WHERE id=$1`, [conversation.id, { mode: "awaiting_address", orderId: pending.id }]);
          return flow.receiveAddress(store, pending, conversation, { text: intent.address_text });
        }
        return flow.startAddressUpdate(store, pending, conversation);
      }
      break;
    default:
      break;
  }
  return agentRespond(store, conversation, text, intent.language);
}

async function handlePayload(store, conversation, payload, customer, text) {
  const [action, ref, extra] = String(payload).split(":");
  const order = await orderForStore(store, ref);
  switch (action) {
    case "CONFIRM":
    case "KEEP":
      if (order) return flow.confirmOrder(store, order, conversation);
      break;
    case "CANCEL":
      if (order) return flow.requestCancel(store, order, conversation);
      break;
    case "CANCEL_REASON":
      if (order) return flow.cancelByCustomer(store, order, conversation, extra || "other");
      break;
    case "ADDRESS":
      if (order) return flow.startAddressUpdate(store, order, conversation);
      break;
    case "ADDR_OK":
      if (order) return flow.addressConfirmedAsIs(store, order, conversation);
      break;
    case "ADDR_NEW_OK":
      if (order) return flow.confirmPendingAddress(store, order, conversation);
      break;
    case "OPTIN_YES":
      await flow.setOptIn(Number(ref) || customer?.id, true, "whatsapp_button");
      return sendText(store, { to: conversation.phone_e164, conversation, kind: "opt_in_ack", body: "Great! 🎉 You'll be the first to hear about our offers. Reply STOP anytime to unsubscribe." });
    case "OPTIN_NO":
    case "STOP":
      await flow.setOptIn(Number(ref) || customer?.id, false);
      return sendText(store, { to: conversation.phone_e164, conversation, kind: "opt_out_ack", body: "No problem, we won't send you offers. You'll still get updates about your orders." });
    default:
      break;
  }
  return agentRespond(store, conversation, text || action);
}

/** AI agent answers, or the conversation is flagged for a human. */
export async function agentRespond(store, conversation, text, language) {
  const s = store.settings.ai;
  const paused = conversation.ai_paused_until && new Date(conversation.ai_paused_until) > new Date();
  if (!s.agent || paused || !aiAvailable(store) || !canMessageFreely(store, conversation)) {
    await query(`UPDATE conversations SET needs_human=true WHERE id=$1`, [conversation.id]);
    return;
  }
  const orders = await many(
    `SELECT o.id, o.name, o.status, o.total, o.currency, o.is_cod, o.address_text, o.shopify_created_at AS created,
            (SELECT json_agg(json_build_object('title', i.title, 'qty', i.quantity)) FROM order_items i WHERE i.order_id=o.id) AS items,
            (SELECT json_agg(json_build_object('company', f.tracking_company, 'number', f.tracking_number, 'status', f.shipment_status))
               FROM fulfillments f WHERE f.order_id=o.id) AS tracking
       FROM orders o WHERE o.store_id=$1 AND o.phone_e164=$2 ORDER BY o.shopify_created_at DESC LIMIT 3`,
    [store.id, conversation.phone_e164]
  );
  const history = (
    await many(`SELECT direction, body FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 10`, [conversation.id])
  )
    .reverse()
    .map((m) => `${m.direction === "in" ? "Customer" : "Store"}: ${m.body}`)
    .join("\n");
  try {
    const r = await agentReply(store, { customerName: conversation.name, orders, history, message: text, language });
    await sendText(store, { to: conversation.phone_e164, conversation, kind: "agent", body: r.reply, aiGenerated: true });
    if (r.handoff) await query(`UPDATE conversations SET needs_human=true WHERE id=$1`, [conversation.id]);
  } catch (err) {
    logger.warn({ err: err.message }, "AI agent failed");
    await query(`UPDATE conversations SET needs_human=true WHERE id=$1`, [conversation.id]);
  }
}

// ---------------------------------------------------------------- statuses & account events

export async function handleStatusEvent(ev) {
  const msg = await applyStatus(ev);
  if (!msg || ev.status !== "failed") return;
  const store = await getStoreContext(msg.store_id);
  const code = String(ev.errors?.[0]?.code || "");
  if (code === "131050" && msg.customer_id) await flow.setOptIn(msg.customer_id, false);
  if (msg.order_id && ["confirmation", "reminder", "tracking"].includes(msg.kind)) {
    const order = await getOrder(msg.order_id);
    if (order) {
      await setOrderStatus(order.id, order.status, { needs_attention: true });
      await queueTags(store, order, { add: ["failed"] });
    }
  }
  if (msg.campaign_id) {
    await query(`UPDATE campaign_recipients SET status='failed' WHERE message_id=$1`, [msg.id]);
  }
}

export async function handleTemplateStatusEvent(ev) {
  const rows = await many(
    `UPDATE templates t SET status=$1, rejection_reason=$2, updated_at=now()
       FROM stores s JOIN whatsapp_numbers w ON w.id = s.whatsapp_number_id
      WHERE t.store_id = s.id AND w.waba_id = $3 AND (t.meta_template_id = $4 OR (t.name = $5 AND t.language = $6))
      RETURNING t.id`,
    [ev.event, ev.reason, ev.wabaId, ev.templateId, ev.name, ev.language]
  );
  logger.info({ template: ev.name, event: ev.event, updated: rows.length }, "template status update");
}

export async function handleQualityEvent(ev) {
  const numbers = await many(
    `UPDATE whatsapp_numbers SET quality_rating = CASE WHEN $2 IN ('FLAGGED','DOWNGRADE') THEN 'RED' WHEN $2 = 'UNFLAGGED' THEN 'GREEN' ELSE quality_rating END,
            messaging_limit = COALESCE($3, messaging_limit), updated_at = now()
      WHERE waba_id = $1 RETURNING id, account_id, display_number`,
    [ev.wabaId, ev.event, ev.limit]
  );
  for (const n of numbers) {
    const stores = await many(`SELECT id FROM stores WHERE whatsapp_number_id=$1`, [n.id]);
    for (const s of stores) {
      invalidateStore(s.id);
      if (["FLAGGED", "DOWNGRADE"].includes(ev.event)) {
        const store = await getStoreContext(s.id);
        if (store.settings.alerts.qualityDrop) {
          await raiseAlert(store, "quality", `quality:${n.id}:${ev.event}:${new Date().toISOString().slice(0, 10)}`,
            `WhatsApp number ${n.display_number || ""} quality event: ${ev.event}${ev.limit ? ` (limit ${ev.limit})` : ""}. Campaigns are paused automatically while quality is low.`);
        }
      }
    }
  }
}
