import { one, query } from "../db/pool.js";
import { enqueue, cancelJobs } from "../queue/queue.js";
import { Reschedule, PermanentError } from "../lib/errors.js";
import { quietHoursEnd } from "../lib/time.js";
import { formatAddress } from "../lib/format.js";
import * as wa from "../whatsapp/cloudApi.js";
import { mapImageUrl, reverseGeocode } from "../google/address.js";
import { aiAvailable } from "../ai/provider.js";
import { parseAddress } from "../ai/features.js";
import { fillText } from "./settings.js";
import { orderContext } from "./context.js";
import { sendTemplate, sendSession, sendText, upsertConversation, windowOpen, canMessageFreely } from "./messaging.js";
import { getOrder, getOrderItems, setOrderStatus, queueTags } from "./orders.js";
import { applyCustomerAddress } from "./address.js";

const HOUR = 3600 * 1000;

export function assertNotQuietHours(store) {
  const end = quietHoursEnd(new Date(), store.timezone, store.settings.quietHours);
  if (end) throw new Reschedule(end, "quiet hours");
}

async function conversationFor(store, order) {
  return upsertConversation(store.id, order.phone_e164, { customerId: order.customer_id, name: order.customer_name });
}

async function setState(conversationId, state) {
  await query(`UPDATE conversations SET state=$2 WHERE id=$1`, [conversationId, state || {}]);
}

const textVars = (order) => ({ name: order.first_name || order.customer_name || "", order: order.name });

// ---------------------------------------------------------------- send + reminders

export async function sendConfirmation(store, orderId, { force = false } = {}) {
  const order = await getOrder(orderId);
  if (!order) return;
  if (!force && order.status !== "new") return; // already handled
  if (!order.phone_e164) throw new PermanentError("Order has no valid phone number");
  const items = await getOrderItems(order.id);
  const ctx = orderContext(store, order, items);
  await sendTemplate(store, {
    kind: "order_confirmation",
    to: order.phone_e164,
    ctx,
    orderId: order.id,
    customerId: order.customer_id,
    messageKind: "confirmation",
    name: order.customer_name,
  });
  const updated = await setOrderStatus(order.id, "awaiting_reply", { confirmation_sent_at: new Date() });
  await queueTags(store, updated, { add: ["sent"] });

  const c = store.settings.confirmation;
  if (c.reminderEnabled && c.reminderHours > 0) {
    await enqueue("confirmation.reminder", { storeId: store.id, orderId: order.id }, {
      delayMs: c.reminderHours * HOUR,
      singletonKey: `order:${order.id}:confirm:reminder`,
    });
  }
  if (c.noResponseHours > 0) {
    await enqueue("confirmation.timeout", { storeId: store.id, orderId: order.id }, {
      delayMs: c.noResponseHours * HOUR,
      singletonKey: `order:${order.id}:confirm:timeout`,
    });
  }
}

export async function sendReminder(store, orderId) {
  const order = await getOrder(orderId);
  if (!order || order.status !== "awaiting_reply") return;
  assertNotQuietHours(store);
  const items = await getOrderItems(order.id);
  await sendTemplate(store, {
    kind: "order_reminder",
    to: order.phone_e164,
    ctx: orderContext(store, order, items),
    orderId: order.id,
    customerId: order.customer_id,
    messageKind: "reminder",
  });
}

export async function markNoResponse(store, orderId) {
  const order = await getOrder(orderId);
  if (!order || order.status !== "awaiting_reply") return;
  const updated = await setOrderStatus(order.id, "no_response", { needs_attention: true });
  await queueTags(store, updated, { add: ["noResponse"] });
}

// ---------------------------------------------------------------- customer actions

async function askToConfirm(store, order, conversation, intro) {
  await sendSession(store, {
    to: order.phone_e164,
    conversation,
    orderId: order.id,
    kind: "confirm_prompt",
    body: `${intro} Shall we go ahead with order ${order.name}?`,
    payload: wa.buttonsPayload({
      body: `${intro}\n\nShall we go ahead with order ${order.name}?`,
      buttons: [
        { id: `CONFIRM:${order.id}`, title: "Confirm order" },
        { id: `CANCEL:${order.id}`, title: "Cancel order" },
      ],
    }),
  });
}

export async function confirmOrder(store, order, conversation, { source = "customer" } = {}) {
  if (order.status === "confirmed") {
    if (conversation && canMessageFreely(store, conversation)) {
      await sendText(store, { to: order.phone_e164, conversation, orderId: order.id, kind: "confirmed_ack", body: `Your order ${order.name} is already confirmed ✅` });
    }
    return order;
  }
  if (["cancelled", "cancelled_by_customer"].includes(order.status)) {
    if (conversation && canMessageFreely(store, conversation)) {
      await sendText(store, { to: order.phone_e164, conversation, orderId: order.id, kind: "confirmed_ack", body: `Order ${order.name} was cancelled. Please reply here if you'd like us to help you place it again.` });
    }
    return order;
  }
  const updated = await setOrderStatus(order.id, "confirmed", { confirmed_at: new Date(), needs_attention: false });
  await cancelJobs(`order:${order.id}:confirm:`);
  await queueTags(store, updated, { add: ["confirmed"], remove: ["sent", "noResponse"] });
  if (source !== "customer" || !conversation) return updated;

  const s = store.settings;
  const addressNeedsCheck =
    s.address.enabled && s.address.askAfterConfirm && ["needs_confirmation", "needs_update"].includes(updated.address_status);
  if (addressNeedsCheck) {
    await sendAddressCheck(store, updated, conversation, { intro: `Thank you! Order ${updated.name} is confirmed ✅` });
  } else {
    await sendThankYou(store, updated, conversation);
  }
  if (s.confirmation.sendProductImages) await sendProductImages(store, updated, conversation).catch(() => {});
  if (s.marketing.codToPrepaid.enabled && updated.is_cod && s.marketing.codToPrepaid.text) {
    await sendText(store, {
      to: updated.phone_e164,
      conversation,
      orderId: updated.id,
      kind: "cod_to_prepaid",
      body: fillText(s.marketing.codToPrepaid.text, { ...textVars(updated), link: s.marketing.codToPrepaid.link }),
    });
  }
  return updated;
}

async function sendThankYou(store, order, conversation) {
  const s = store.settings;
  const body = fillText(s.confirmation.thankYouText, textVars(order));
  const customer = order.customer_id ? await one(`SELECT wa_opt_in, opted_out_at FROM customers WHERE id=$1`, [order.customer_id]) : null;
  if (s.marketing.optInAfterConfirm && customer && !customer.wa_opt_in && !customer.opted_out_at) {
    await sendSession(store, {
      to: order.phone_e164,
      conversation,
      orderId: order.id,
      kind: "confirmed_ack",
      body: `${body} Want exclusive offers on WhatsApp?`,
      payload: wa.buttonsPayload({
        body: `${body}\n\nWould you like to receive exclusive offers and new arrivals on WhatsApp?`,
        buttons: [
          { id: `OPTIN_YES:${order.customer_id}`, title: "Yes, send offers" },
          { id: `OPTIN_NO:${order.customer_id}`, title: "No thanks" },
        ],
      }),
    });
  } else {
    await sendText(store, { to: order.phone_e164, conversation, orderId: order.id, kind: "confirmed_ack", body });
  }
}

export async function sendProductImages(store, order, conversation) {
  const items = await getOrderItems(order.id);
  for (const it of items.filter((i) => i.image_url).slice(0, 5)) {
    await sendSession(store, {
      to: order.phone_e164,
      conversation,
      orderId: order.id,
      kind: "product_images",
      body: `[image] ${it.title}`,
      payload: wa.imagePayload({ link: it.image_url, caption: `${it.quantity}× ${it.title}` }),
    });
  }
}

const CANCEL_REASONS = [
  ["changed_mind", "Changed my mind"],
  ["ordered_by_mistake", "Ordered by mistake"],
  ["found_cheaper", "Found it cheaper"],
  ["delivery_too_long", "Delivery takes too long"],
  ["other", "Other reason"],
];

export async function requestCancel(store, order, conversation) {
  if (["cancelled", "cancelled_by_customer"].includes(order.status)) return;
  if (!store.settings.confirmation.askCancelReason || !conversation || !canMessageFreely(store, conversation)) {
    return cancelByCustomer(store, order, conversation, "not_given");
  }
  await sendSession(store, {
    to: order.phone_e164,
    conversation,
    orderId: order.id,
    kind: "cancel_reason",
    body: "Sorry to see that! Could you tell us why you want to cancel?",
    payload: wa.listPayload({
      body: `Sorry to see that! Could you tell us why you want to cancel order ${order.name}?`,
      button: "Choose reason",
      sections: [
        {
          title: "Cancel order",
          rows: [
            ...CANCEL_REASONS.map(([id, title]) => ({ id: `CANCEL_REASON:${order.id}:${id}`, title })),
            { id: `KEEP:${order.id}`, title: "Keep my order", description: "Don't cancel, ship it" },
          ],
        },
      ],
    }),
  });
}

export async function cancelByCustomer(store, order, conversation, reason) {
  const updated = await setOrderStatus(order.id, "cancelled_by_customer", { cancelled_at: new Date(), cancel_reason: reason, needs_attention: false });
  await cancelJobs(`order:${order.id}:confirm:`);
  await queueTags(store, updated, { add: ["cancelled"], remove: ["sent", "confirmed", "noResponse"] });
  if (store.settings.confirmation.autoCancelInShopify) {
    await enqueue("shopify.cancel", { storeId: store.id, orderId: order.id }, { singletonKey: `order:${order.id}:shopify-cancel` });
  }
  if (conversation && canMessageFreely(store, conversation)) {
    await sendText(store, {
      to: order.phone_e164,
      conversation,
      orderId: order.id,
      kind: "cancel_ack",
      body: fillText(store.settings.confirmation.cancelText, textVars(updated)),
    });
  }
  return updated;
}

// ---------------------------------------------------------------- address flow

/** Asks the customer to confirm the address on file (map image + buttons). */
export async function sendAddressCheck(store, order, conversation, { intro } = {}) {
  conversation = conversation || (await conversationFor(store, order));
  const text = order.address_text || formatAddress(order.shipping_address) || "(no address)";
  if (order.address_status === "needs_update" && canMessageFreely(store, conversation)) {
    return startAddressUpdate(store, order, conversation, {
      intro: `${intro ? `${intro}\n\n` : ""}We couldn't fully locate your delivery address:\n📍 ${text}`,
    });
  }
  if (!canMessageFreely(store, conversation)) {
    // Outside the 24h window we need the approved template.
    const items = await getOrderItems(order.id);
    await sendTemplate(store, {
      kind: "address_confirmation",
      to: order.phone_e164,
      ctx: orderContext(store, order, items),
      orderId: order.id,
      customerId: order.customer_id,
      messageKind: "address_request",
    });
  } else {
    const map = mapImageUrl(order.lat, order.lng);
    await sendSession(store, {
      to: order.phone_e164,
      conversation,
      orderId: order.id,
      kind: "address_request",
      body: `Please confirm your delivery address: ${text}`,
      payload: wa.buttonsPayload({
        header: map ? { type: "image", image: { link: map } } : undefined,
        body: `${intro ? `${intro}\n\n` : ""}Please confirm your delivery address:\n📍 ${text}`,
        buttons: [
          { id: `ADDR_OK:${order.id}`, title: "Yes, correct" },
          { id: `ADDRESS:${order.id}`, title: "Update address" },
        ],
      }),
    });
  }
  await setOrderStatus(order.id, order.status, { address_status: "awaiting_customer" });
}

export async function startAddressUpdate(store, order, conversation, { intro } = {}) {
  await setState(conversation.id, { mode: "awaiting_address", orderId: order.id, attempts: 0 });
  await setOrderStatus(order.id, order.status, { address_status: "awaiting_customer" });
  const body =
    `${intro ? `${intro}\n\n` : ""}Please share your location 📍 using the button below, or type your complete address ` +
    "(house/flat no., street, area/sector, city and a nearby landmark).";
  await sendSession(store, {
    to: order.phone_e164,
    conversation,
    orderId: order.id,
    kind: "address_request",
    body,
    payload: wa.locationRequestPayload(body),
  });
}

/** Customer sent a location pin or typed an address while we were waiting for one. */
export async function receiveAddress(store, order, conversation, { text, location }) {
  const state = conversation.state || {};
  let addr;
  if (location) {
    const geo = store.apiKeys.google ? await reverseGeocode(location.lat, location.lng, store.apiKeys.google).catch(() => null) : null;
    addr = {
      address1: location.address || geo?.address1 || location.name || `Pinned location (${location.lat}, ${location.lng})`,
      address2: geo?.address2 || null,
      city: geo?.city || order.shipping_address?.city,
      province: geo?.province,
      provinceCode: geo?.provinceCode,
      zip: geo?.zip,
      countryCode: geo?.countryCode,
      country: geo?.country,
      lat: location.lat,
      lng: location.lng,
      complete: true,
      missing: [],
    };
  } else if (aiAvailable(store) && store.settings.address.useAi) {
    const p = await parseAddress(store, text, { country: store.country, current: order.address_text });
    addr = { ...p, countryCode: p.country_code };
  } else {
    addr = { address1: text, city: order.shipping_address?.city, complete: true, missing: [] };
  }

  const attempts = (state.attempts || 0) + 1;
  if (!addr.complete && addr.missing?.length && attempts < 2) {
    await setState(conversation.id, { ...state, attempts });
    await sendText(store, {
      to: order.phone_e164,
      conversation,
      orderId: order.id,
      kind: "address_request",
      body: `Thanks! To make sure the rider finds you, please also send: ${addr.missing.join(", ")}.`,
    });
    return;
  }

  const preview = formatAddress(addr);
  await setState(conversation.id, { mode: "confirm_new_address", orderId: order.id, pending: addr });
  const map = mapImageUrl(addr.lat, addr.lng);
  await sendSession(store, {
    to: order.phone_e164,
    conversation,
    orderId: order.id,
    kind: "address_request",
    body: `Is this your correct address? ${preview}`,
    payload: wa.buttonsPayload({
      header: map ? { type: "image", image: { link: map } } : undefined,
      body: `Is this your correct delivery address?\n📍 ${preview}`,
      buttons: [
        { id: `ADDR_NEW_OK:${order.id}`, title: "Yes, correct" },
        { id: `ADDRESS:${order.id}`, title: "Edit again" },
      ],
    }),
  });
}

export async function confirmPendingAddress(store, order, conversation) {
  const pending = conversation.state?.pending;
  if (!pending) return startAddressUpdate(store, order, conversation);
  const updated = await applyCustomerAddress(store, order, pending, { source: pending.lat ? "customer_location" : "customer_text" });
  await setState(conversation.id, {});
  await afterAddressSettled(store, updated, conversation, "Your delivery address has been updated ✅");
}

export async function addressConfirmedAsIs(store, order, conversation) {
  const updated = await setOrderStatus(order.id, order.status, { address_status: "verified" });
  await queueTags(store, updated, { add: ["addressVerified"], remove: ["addressIssue"] });
  await setState(conversation.id, {});
  await afterAddressSettled(store, updated, conversation, "Thank you for confirming your address ✅");
}

async function afterAddressSettled(store, order, conversation, intro) {
  if (order.status === "awaiting_reply" || order.status === "no_response") {
    await askToConfirm(store, order, conversation, intro);
  } else {
    await sendText(store, { to: order.phone_e164, conversation, orderId: order.id, kind: "address_ack", body: `${intro} We'll ship order ${order.name} to this address.` });
  }
}

export async function setOptIn(customerId, optIn, source) {
  if (!customerId) return;
  if (optIn) {
    await query(`UPDATE customers SET wa_opt_in=true, opt_in_source=$2, opt_in_at=now(), opted_out_at=NULL WHERE id=$1`, [customerId, source]);
  } else {
    await query(`UPDATE customers SET wa_opt_in=false, opted_out_at=now() WHERE id=$1`, [customerId]);
  }
}
