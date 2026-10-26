/** Ratings and photo reviews collected on WhatsApp after delivery. */
import { one, many, query } from "../db/pool.js";
import { enqueue } from "../queue/queue.js";
import { randomToken } from "../lib/crypto.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import * as wa from "../whatsapp/cloudApi.js";
import { getOrder, getOrderItems } from "./orders.js";
import { orderContext } from "./context.js";
import { sendTemplate, sendText } from "./messaging.js";
import { assertNotQuietHours } from "./confirmation.js";
import { notify } from "./notifications.js";
import { emitEvent } from "./webhooksOut.js";

export async function scheduleReviewAsk(store, order) {
  const r = store.settings.reviews;
  if (!r.enabled || !order.phone_e164) return;
  await enqueue("review.ask", { storeId: store.id, orderId: order.id }, { delayMs: Number(r.delayDays ?? 3) * 86400000, singletonKey: `order:${order.id}:review-ask` });
}

export async function sendReviewAsk(store, orderId) {
  const order = await getOrder(orderId);
  if (!order?.phone_e164 || order.status !== "delivered") return;
  if (await one(`SELECT 1 FROM reviews WHERE order_id=$1`, [order.id])) return;
  assertNotQuietHours(store);
  const items = await getOrderItems(order.id);
  await query(
    `INSERT INTO reviews (store_id, order_id, customer_id, shopify_product_id, customer_name, status) VALUES ($1,$2,$3,$4,$5,'requested')`,
    [store.id, order.id, order.customer_id, items[0]?.product_id || null, order.customer_name]
  );
  await sendTemplate(store, { kind: "review_ask", to: order.phone_e164, ctx: orderContext(store, order, items), orderId: order.id, customerId: order.customer_id, messageKind: "review_ask" });
}

/** Customer tapped a rating button (REVIEW_5 / REVIEW_4 / REVIEW_2). */
export async function receiveRating(store, order, conversation, rating, flagHuman) {
  let review = await one(`SELECT * FROM reviews WHERE order_id=$1 ORDER BY id DESC LIMIT 1`, [order.id]);
  if (!review) {
    review = await one(`INSERT INTO reviews (store_id, order_id, customer_id, customer_name, status) VALUES ($1,$2,$3,$4,'pending') RETURNING *`, [store.id, order.id, order.customer_id, order.customer_name]);
  }
  const r = store.settings.reviews;
  const publish = rating >= Number(r.autoPublishMin || 5) && !r.askPhoto;
  review = await one(`UPDATE reviews SET rating=$2, status=$3, updated_at=now() WHERE id=$1 RETURNING *`, [review.id, rating, publish ? "published" : "pending"]);
  if (rating <= 2) {
    await sendText(store, { to: order.phone_e164, conversation, orderId: order.id, kind: "review_reply", body: "We're really sorry to hear that 😔 Please tell us what went wrong. A team member will help you personally." });
    await query(`UPDATE conversations SET state = state || $2 WHERE id=$1`, [conversation.id, { mode: "awaiting_review", reviewId: review.id, until: Date.now() + 2 * 86400000 }]);
    await flagHuman(store, conversation, "is unhappy with their order");
    await notify({ accountId: store.accountId, storeId: store.id, kind: "review.low", severity: "danger", title: `Unhappy customer: ${order.name}`, body: `${order.customer_name || order.phone_e164} rated ${rating}/5`, link: `/inbox/${conversation.id}` });
  } else if (r.askPhoto) {
    await sendText(store, { to: order.phone_e164, conversation, orderId: order.id, kind: "review_reply", body: "Thank you so much! 💚 Would you like to share a photo or a few words about it? Just send it here (optional)." });
    await query(`UPDATE conversations SET state = state || $2 WHERE id=$1`, [conversation.id, { mode: "awaiting_review", reviewId: review.id, until: Date.now() + 2 * 86400000 }]);
  } else {
    await sendText(store, { to: order.phone_e164, conversation, orderId: order.id, kind: "review_reply", body: "Thank you for your feedback! 💚" });
  }
  await emitEvent({ accountId: store.accountId, event: "review.created", data: { id: review.id, order_id: order.id, rating, status: review.status } });
  return review;
}

/** Text and/or photo sent after the rating. Returns true when it was consumed as review content. */
export async function receiveReviewContent(store, conversation, ev, text) {
  const st = conversation.state || {};
  if (st.mode !== "awaiting_review" || !st.reviewId || Date.now() > Number(st.until || 0)) return false;
  if (!text && !ev.media) return false;
  const media = [];
  if (ev.media && (ev.kind === "image" || /^image\//.test(ev.media.mime || ""))) {
    try {
      const file = ev.media.base64 ? { buffer: Buffer.from(ev.media.base64, "base64"), mime: ev.media.mime || "image/jpeg" } : await wa.downloadMedia(store.wa, ev.media.id);
      const token = randomToken(18).replace(/[^a-zA-Z0-9]/g, "");
      await query(`INSERT INTO media_files (store_id, token, filename, mime, data) VALUES ($1,$2,$3,$4,$5)`, [store.id, token, "review.jpg", file.mime || "image/jpeg", file.buffer]);
      media.push({ url: `${config.baseUrl}/media/f/${token}/review.jpg` });
    } catch (err) {
      logger.warn({ err: err.message }, "review photo download failed");
    }
  }
  const review = await one(`SELECT * FROM reviews WHERE id=$1`, [st.reviewId]);
  if (!review) return false;
  const publish = Number(review.rating || 0) >= Number(store.settings.reviews.autoPublishMin || 5);
  await query(
    `UPDATE reviews SET body = CASE WHEN $2 <> '' THEN concat_ws(' ', body, $2) ELSE body END, media = media || $3::jsonb,
            status = CASE WHEN $4 THEN 'published' ELSE status END, updated_at=now() WHERE id=$1`,
    [review.id, String(text || "").slice(0, 2000), JSON.stringify(media), publish]
  );
  await query(`UPDATE conversations SET state = state - 'mode' - 'reviewId' - 'until' WHERE id=$1`, [conversation.id]);
  if (Number(review.rating || 0) > 2) {
    await sendText(store, { to: conversation.phone_e164, conversation, kind: "review_reply", body: "Thank you! 🙏 Your review means a lot to us." });
  }
  return true;
}

export async function listReviews(storeIds, { status, limit = 100 } = {}) {
  return many(
    `SELECT r.*, o.name AS order_name, s.name AS store_name, p.title AS product_title, p.image_url AS product_image
       FROM reviews r JOIN stores s ON s.id=r.store_id LEFT JOIN orders o ON o.id=r.order_id
       LEFT JOIN products p ON p.store_id=r.store_id AND p.shopify_product_id=r.shopify_product_id
      WHERE r.store_id = ANY($1) ${status ? "AND r.status=$2" : "AND r.status <> 'requested'"} ORDER BY r.created_at DESC LIMIT ${Number(limit)}`,
    status ? [storeIds, status] : [storeIds]
  );
}
