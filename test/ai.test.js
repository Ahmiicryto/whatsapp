import "./env.js";
import "./ai-env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, client, worker, calls, waSends, sendShopifyWebhook, sendWaWebhook, inboundMessage, q, mock, shopifyCalls } from "./helpers.js";

const owner = client();
let storeId;

function openaiReply(content) {
  return { choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
}

before(async () => {
  await setup();
  mock(
    (u) => u.endsWith("/chat/completions"),
    (_u, body) => {
      const name = body.response_format?.json_schema?.name;
      const msg = body.messages[1].content;
      if (name === "intent") {
        if (/kab ayega/.test(msg)) return openaiReply({ intent: "where_is_order", confidence: 0.92, language: "ur-Latn", address_text: null });
        if (/ghar ka address/.test(msg)) return openaiReply({ intent: "change_address", confidence: 0.9, language: "ur-Latn", address_text: null });
        return openaiReply({ intent: "other", confidence: 0.5, language: "en", address_text: null });
      }
      if (name === "agent") return openaiReply({ reply: "Aapka order #2001 confirm ho chuka hai, jald ship hoga!", handoff: false, reason: "answered" });
      if (name === "address_parse") return openaiReply({ address1: "House 45, Street 9", address2: "Gulberg III", landmark: "near Liberty Market", city: "Lahore", province: "Punjab", zip: null, country_code: "PK", complete: true, missing: [] });
      if (name === "address_assess") return openaiReply({ score: 90, missing: [], reason: "complete" });
      return openaiReply({});
    }
  );
  await owner.post("/api/auth/signup", { name: "O", email: "o@example.com", password: "password123", accountName: "A" });
  const s = await owner.post("/api/stores", { shopDomain: "glow", accessToken: "shpat_1234567890", webhookSecret: "shpss_store_secret" });
  storeId = s.body.id;
  await owner.post(`/api/stores/${storeId}/whatsapp`, { phoneNumberId: "109876543210987", wabaId: "WABA1", accessToken: "EAAG-test-token-123456789" });
  await worker.drain();
  await q(`UPDATE templates SET status='APPROVED' WHERE store_id=$1`, [storeId]);
  await owner.put(`/api/stores/${storeId}/settings`, { confirmation: { delayMinutes: 0 } });
});
after(teardown);

const order = {
  id: 5001,
  name: "#2001",
  created_at: new Date().toISOString(),
  payment_gateway_names: ["Cash on Delivery (COD)"],
  total_price: "2000.00",
  currency: "PKR",
  shipping_address: { first_name: "Ali", name: "Ali Raza", address1: "House 45", city: "Lahore", country_code: "PK", phone: "03001112222" },
  line_items: [{ id: 1, product_id: 401, variant_id: 501, title: "Candle", quantity: 1, price: "2000.00" }],
};

test("AI address assessment is blended into the address score", async () => {
  await sendShopifyWebhook("orders/create", order);
  await worker.drain();
  const [o] = await q(`SELECT address_score, status FROM orders WHERE shopify_order_id=5001`);
  assert.equal(o.status, "awaiting_reply");
  const ai = calls.filter((c) => c.url.endsWith("/chat/completions") && c.body.response_format?.json_schema?.name === "address_assess");
  assert.equal(ai.length, 1);
  assert.ok(o.address_score > 0);
});

test("Roman Urdu question -> AI intent -> AI agent answers with order context", async () => {
  calls.length = 0;
  await sendWaWebhook(inboundMessage("923001112222", { type: "text", text: { body: "mera order kab ayega?" } }));
  await worker.drain();
  const agentCall = calls.find((c) => c.body?.response_format?.json_schema?.name === "agent");
  assert.ok(agentCall, "agent called");
  assert.match(agentCall.body.messages[1].content, /#2001/);
  const reply = waSends().at(-1);
  assert.equal(reply.body.type, "text");
  assert.match(reply.body.text.body, /confirm ho chuka|ship/);
  const [m] = await q(`SELECT ai_generated FROM messages WHERE direction='out' ORDER BY id DESC LIMIT 1`);
  assert.equal(m.ai_generated, true);
  const logs = await q(`SELECT feature, input_tokens FROM ai_logs WHERE store_id=$1`, [storeId]);
  assert.ok(logs.some((l) => l.feature === "intent" && l.input_tokens === 100));
});

test("AI parses a typed address into structured fields and writes it to Shopify", async () => {
  calls.length = 0;
  await sendWaWebhook(inboundMessage("923001112222", { type: "text", text: { body: "mujhe ghar ka address change karna hai" } }));
  await worker.drain();
  assert.equal(waSends().at(-1).body.interactive.type, "location_request_message");
  await sendWaWebhook(inboundMessage("923001112222", { type: "text", text: { body: "house 45 street 9 gulberg 3 near liberty lahore" } }));
  await worker.drain();
  const [o] = await q(`SELECT id FROM orders WHERE shopify_order_id=5001`);
  await sendWaWebhook(inboundMessage("923001112222", { type: "interactive", interactive: { type: "button_reply", button_reply: { id: `ADDR_NEW_OK:${o.id}`, title: "Yes" } } }));
  await worker.drain();
  const upd = shopifyCalls("orderUpdate").at(-1).body.variables.input.shippingAddress;
  assert.equal(upd.address1, "House 45, Street 9");
  assert.equal(upd.address2, "Gulberg III, near Liberty Market");
  assert.equal(upd.city, "Lahore");
});

test("AI copywriter returns campaign variants", async () => {
  mock(
    (u, b) => u.endsWith("/chat/completions") && b.response_format?.json_schema?.name === "copy_campaign",
    () => openaiReply({ variants: [{ text: "Eid Mubarak! 🌙 30% off all candles", angle: "festive" }] })
  );
  const r = await owner.post("/api/ai/copy", { storeId, brief: "Eid sale 30% off", kind: "campaign", language: "Roman Urdu" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.variants[0].angle, "festive");
});

test("Ask your data answers from store metrics", async () => {
  mock(
    (u, b) => u.endsWith("/chat/completions") && !b.response_format,
    (_u, b) => {
      assert.match(b.messages[1].content, /"orders":"?\d/);
      return { choices: [{ message: { content: "You had 1 order in the last 7 days." } }], usage: {} };
    }
  );
  const r = await owner.post("/api/ai/ask", { question: "How many orders this week?" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.answer, /1 order/);
});
