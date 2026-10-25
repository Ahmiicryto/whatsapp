import { Router } from "express";
import { z } from "zod";
import { one, many, query } from "../../db/pool.js";
import { ah, badRequest } from "../../lib/errors.js";
import { scopeStoreIds, assertRow, assertStore } from "../auth.js";
import { getStoreContext } from "../../services/stores.js";
import { sendText, sendSession, sendTemplate, windowOpen, canMessageFreely, upsertConversation } from "../../services/messaging.js";
import { customerContext } from "../../services/context.js";
import * as wa from "../../whatsapp/cloudApi.js";
import { agentReply } from "../../ai/features.js";
import { aiAvailable } from "../../ai/provider.js";
import { normalizePhone } from "../../lib/phone.js";

const r = Router();

r.get(
  "/conversations",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const params = [storeIds];
    const where = ["c.store_id = ANY($1)"];
    if (req.query.status) {
      params.push(req.query.status);
      where.push(`c.status = $${params.length}`);
    }
    if (req.query.needsHuman === "1") where.push("c.needs_human");
    if (req.query.assigned === "me") {
      params.push(req.user.id);
      where.push(`c.assigned_user_id = $${params.length}`);
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where.push(`(c.name ILIKE $${params.length} OR c.phone_e164 ILIKE $${params.length} OR c.last_message_preview ILIKE $${params.length})`);
    }
    const rows = await many(
      `SELECT c.*, s.name AS store_name, u.name AS assigned_name
         FROM conversations c JOIN stores s ON s.id=c.store_id LEFT JOIN users u ON u.id=c.assigned_user_id
        WHERE ${where.join(" AND ")} AND c.last_message_at IS NOT NULL
        ORDER BY c.last_message_at DESC LIMIT 100`,
      params
    );
    const gatewayStores = new Set(
      (await many(`SELECT s.id FROM stores s JOIN whatsapp_numbers w ON w.id=s.whatsapp_number_id WHERE s.id = ANY($1) AND w.provider='gateway'`, [storeIds])).map((r) => r.id)
    );
    res.json(rows.map((c) => ({ ...c, window_open: gatewayStores.has(c.store_id) || windowOpen(c) })));
  })
);

r.get(
  "/conversations/:id",
  ah(async (req, res) => {
    const conv = await assertRow(req, "conversations", req.params.id);
    const messages = await many(
      `SELECT m.id, m.direction, m.kind, m.template_name, m.body, m.status, m.error_text, m.ai_generated, m.media, m.created_at, m.order_id,
              u.name AS sent_by
         FROM messages m LEFT JOIN users u ON u.id=m.sent_by_user_id
        WHERE m.conversation_id=$1 ORDER BY m.created_at DESC LIMIT 200`,
      [conv.id]
    );
    const customer = conv.customer_id ? await one(`SELECT * FROM customers WHERE id=$1`, [conv.customer_id]) : null;
    const orders = await many(
      `SELECT id, name, status, total, currency, address_status, shopify_created_at FROM orders WHERE store_id=$1 AND phone_e164=$2 ORDER BY shopify_created_at DESC LIMIT 5`,
      [conv.store_id, conv.phone_e164]
    );
    const templates = await many(`SELECT id, name, kind, category, body, variables, language FROM templates WHERE store_id=$1 AND status='APPROVED' ORDER BY kind`, [conv.store_id]);
    const store = await getStoreContext(conv.store_id);
    res.json({ conversation: { ...conv, window_open: canMessageFreely(store, conv) }, messages: messages.reverse(), customer, orders, templates });
  })
);

const sendSchema = z.object({
  text: z.string().max(4096).optional(),
  imageUrl: z.string().url().optional(),
  caption: z.string().max(1024).optional(),
  templateId: z.number().int().optional(),
  variables: z.record(z.string()).optional(),
});

async function pauseAi(store, convId) {
  const hours = Number(store.settings.ai.humanPauseHours || 12);
  await query(`UPDATE conversations SET ai_paused_until = now() + ($2 || ' hours')::interval, needs_human=false, unread=0 WHERE id=$1`, [convId, String(hours)]);
}

r.post(
  "/conversations/:id/send",
  ah(async (req, res) => {
    const conv = await assertRow(req, "conversations", req.params.id, "agent");
    const body = sendSchema.parse(req.body);
    const store = await getStoreContext(conv.store_id);
    let msg;
    if (body.templateId) {
      const tpl = await one(`SELECT * FROM templates WHERE id=$1 AND store_id=$2 AND status='APPROVED'`, [body.templateId, store.id]);
      if (!tpl) throw badRequest("Template not found or not approved");
      const customer = conv.customer_id ? await one(`SELECT * FROM customers WHERE id=$1`, [conv.customer_id]) : { id: null, name: conv.name, phone_e164: conv.phone_e164 };
      const ctx = { ...customerContext(store, customer), ...(body.variables || {}) };
      msg = await sendTemplate(store, { template: tpl, to: conv.phone_e164, ctx, customerId: conv.customer_id, messageKind: "manual" });
    } else if (body.imageUrl) {
      msg = await sendSession(store, { to: conv.phone_e164, conversation: conv, kind: "manual", userId: req.user.id, body: `[image] ${body.caption || ""}`, payload: wa.imagePayload({ link: body.imageUrl, caption: body.caption }) });
    } else if (body.text) {
      msg = await sendText(store, { to: conv.phone_e164, conversation: conv, kind: "manual", userId: req.user.id, body: body.text });
    } else throw badRequest("Nothing to send");
    await query(`UPDATE messages SET sent_by_user_id=$2 WHERE id=$1`, [msg.id, req.user.id]);
    await pauseAi(store, conv.id);
    res.json(msg);
  })
);

r.post(
  "/conversations/start",
  ah(async (req, res) => {
    const { storeId, phone, templateId, variables } = z
      .object({ storeId: z.number().int(), phone: z.string(), templateId: z.number().int(), variables: z.record(z.string()).optional() })
      .parse(req.body);
    await assertStore(req, storeId, "agent");
    const store = await getStoreContext(storeId);
    const to = normalizePhone(phone, store.country);
    if (!to) throw badRequest("Invalid phone number");
    const tpl = await one(`SELECT * FROM templates WHERE id=$1 AND store_id=$2 AND status='APPROVED'`, [templateId, store.id]);
    if (!tpl) throw badRequest("Template not found or not approved");
    const customer = await one(`SELECT * FROM customers WHERE store_id=$1 AND phone_e164=$2 LIMIT 1`, [store.id, to]);
    const conv = await upsertConversation(store.id, to, { customerId: customer?.id });
    const ctx = { ...customerContext(store, customer || { id: null, name: null, phone_e164: to }), ...(variables || {}) };
    await sendTemplate(store, { template: tpl, to, ctx, customerId: customer?.id, messageKind: "manual" });
    res.json({ conversationId: conv.id });
  })
);

r.post(
  "/conversations/:id/suggest",
  ah(async (req, res) => {
    const conv = await assertRow(req, "conversations", req.params.id, "agent");
    const store = await getStoreContext(conv.store_id);
    if (!aiAvailable(store)) throw badRequest("AI is not configured for this store");
    const last = await many(`SELECT direction, body FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 12`, [conv.id]);
    const lastIn = last.find((m) => m.direction === "in");
    const orders = await many(
      `SELECT name, status, total, currency, address_text FROM orders WHERE store_id=$1 AND phone_e164=$2 ORDER BY shopify_created_at DESC LIMIT 3`,
      [conv.store_id, conv.phone_e164]
    );
    const history = last.reverse().map((m) => `${m.direction === "in" ? "Customer" : "Store"}: ${m.body}`).join("\n");
    const out = await agentReply(store, { customerName: conv.name, orders, history, message: lastIn?.body || "(no message)" });
    res.json({ suggestion: out.reply, handoff: out.handoff, reason: out.reason });
  })
);

r.patch(
  "/conversations/:id",
  ah(async (req, res) => {
    const conv = await assertRow(req, "conversations", req.params.id, "agent");
    const b = z
      .object({
        status: z.enum(["open", "resolved"]).optional(),
        assigned_user_id: z.number().int().nullable().optional(),
        needs_human: z.boolean().optional(),
        ai_paused: z.boolean().optional(),
        unread: z.literal(0).optional(),
      })
      .parse(req.body);
    const row = await one(
      `UPDATE conversations SET status=COALESCE($2,status),
         assigned_user_id = CASE WHEN $3 THEN $4 ELSE assigned_user_id END,
         needs_human=COALESCE($5,needs_human),
         ai_paused_until = CASE WHEN $6::boolean IS NULL THEN ai_paused_until WHEN $6 THEN now() + interval '30 days' ELSE NULL END,
         unread = COALESCE($7, unread)
       WHERE id=$1 RETURNING *`,
      [conv.id, b.status ?? null, "assigned_user_id" in b, b.assigned_user_id ?? null, b.needs_human ?? null, b.ai_paused ?? null, b.unread ?? null]
    );
    res.json(row);
  })
);

export default r;
