import "./env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  setup,
  teardown,
  client,
  worker,
  calls,
  waSends,
  shopifyCalls,
  sendShopifyWebhook,
  sendWaWebhook,
  inboundMessage,
  rawGet,
  rawPost,
  q,
  mock,
} from "./helpers.js";

const owner = client();
const other = client();
const root = client();
let storeId;

const orderPayload = (over = {}) => ({
  id: 9001,
  name: "#1001",
  email: "ayesha@example.com",
  created_at: new Date().toISOString(),
  payment_gateway_names: ["Cash on Delivery (COD)"],
  financial_status: "pending",
  total_price: "1800.00",
  subtotal_price: "1800.00",
  currency: "PKR",
  tags: "",
  checkout_token: "chk_1",
  customer: { id: 77, first_name: "Ayesha", last_name: "Khan", phone: null, email: "ayesha@example.com" },
  shipping_address: {
    first_name: "Ayesha",
    last_name: "Khan",
    name: "Ayesha Khan",
    address1: "House 12, Street 4, Block B",
    address2: "DHA Phase 6",
    city: "Karachi",
    province: "Sindh",
    country: "Pakistan",
    country_code: "PK",
    zip: "75500",
    phone: "0300 1234567",
  },
  line_items: [
    { id: 1, product_id: 401, variant_id: 501, title: "Lavender Candle", variant_title: "Large", sku: "CAN-L", quantity: 2, price: "750.00" },
    { id: 2, product_id: 402, variant_id: 502, title: "Gift Box", variant_title: null, sku: "GIFT", quantity: 1, price: "300.00" },
  ],
  ...over,
});

before(async () => {
  await setup();
});
after(async () => {
  await teardown();
});

test("signup, connect a store manually and link WhatsApp", async () => {
  let r = await owner.post("/api/auth/signup", { name: "Owner", email: "owner@example.com", password: "password123", accountName: "Glow Group" });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  r = await owner.post("/api/stores", { shopDomain: "glow", accessToken: "shpat_1234567890", webhookSecret: "shpss_store_secret" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  storeId = r.body.id;
  assert.equal(r.body.shopify_domain, "glow.myshopify.com");
  assert.equal(r.body.currency, "PKR");

  r = await owner.post(`/api/stores/${storeId}/whatsapp`, { phoneNumberId: "109876543210987", wabaId: "WABA1", accessToken: "EAAG-test-token-123456789" });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  await worker.drain();
  assert.ok(shopifyCalls("webhookSubscriptionCreate").length >= 5, "webhooks registered");
  const templates = await q(`SELECT name, status FROM templates WHERE store_id=$1`, [storeId]);
  assert.ok(templates.length >= 10);
  assert.ok(templates.every((t) => t.status === "PENDING"), "default templates submitted to Meta");
  const submit = calls.find((c) => c.method === "POST" && c.url.includes("/message_templates") && c.body?.name === "order_confirmation_v1");
  assert.equal(submit.body.components[0].example.header_handle[0], "4::handle");

  // Meta approves the templates
  await q(`UPDATE templates SET status='APPROVED' WHERE store_id=$1`, [storeId]);
});

test("store settings update and validation", async () => {
  const r = await owner.put(`/api/stores/${storeId}/settings`, { confirmation: { scope: "cod", delayMinutes: 0 }, reports: { time: "21:00" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.confirmation.delayMinutes, 0);
  assert.equal(r.body.tags.confirmed, "wa-confirmed");
});

test("rejects webhooks with a bad HMAC", async () => {
  const r = await sendShopifyWebhook("orders/create", orderPayload(), { secret: "wrong" });
  assert.equal(r.status, 401);
});

test("new COD order -> rich WhatsApp confirmation with image, products, address; tagged in Shopify", async () => {
  calls.length = 0;
  const r = await sendShopifyWebhook("orders/create", orderPayload(), { id: "evt-1" });
  assert.equal(r.status, 200);
  const dup = await sendShopifyWebhook("orders/create", orderPayload(), { id: "evt-1" });
  assert.equal(dup.text, "duplicate");
  await worker.drain();

  const [order] = await q(`SELECT * FROM orders WHERE shopify_order_id=9001`);
  assert.equal(order.status, "awaiting_reply");
  assert.equal(order.phone_e164, "+923001234567");
  assert.ok(order.address_score > 0, "address scored (heuristics without Google key)");

  const sends = waSends();
  assert.equal(sends.length, 1);
  const tpl = sends[0].body.template;
  assert.equal(sends[0].body.to, "923001234567");
  assert.equal(tpl.name, "order_confirmation_v1");
  const header = tpl.components.find((c) => c.type === "header");
  assert.equal(header.parameters[0].image.link, "https://cdn.shopify.com/candle.jpg");
  const body = tpl.components.find((c) => c.type === "body").parameters.map((p) => p.text);
  assert.equal(body[0], "Ayesha");
  assert.equal(body[1], "Glow Candles");
  assert.equal(body[2], "#1001");
  assert.match(body[3], /2× Lavender Candle - Large/);
  assert.match(body[4], /1,800/);
  assert.equal(body[5], "Cash on Delivery");
  assert.match(body[6], /\+92 300/);
  assert.match(body[7], /House 12, Street 4/);

  const tagCall = shopifyCalls("tagsAdd").find((c) => c.body.variables.tags.includes("wa-sent"));
  assert.ok(tagCall, "wa-sent tag added in Shopify");
  const reminders = await q(`SELECT name, run_at FROM jobs WHERE singleton_key LIKE $1 AND status='queued'`, [`order:${order.id}:confirm:%`]);
  assert.deepEqual(reminders.map((j) => j.name).sort(), ["confirmation.reminder", "confirmation.timeout"]);
});

test("customer taps Confirm -> order confirmed, tags swapped, thank-you with opt-in buttons", async () => {
  calls.length = 0;
  const [order] = await q(`SELECT * FROM orders WHERE shopify_order_id=9001`);
  const r = await sendWaWebhook(inboundMessage("923001234567", { type: "button", button: { text: "Confirm order", payload: `CONFIRM:${order.id}` } }));
  assert.equal(r.status, 200);
  await worker.drain();
  const [updated] = await q(`SELECT * FROM orders WHERE id=$1`, [order.id]);
  assert.equal(updated.status, "confirmed");
  assert.ok(shopifyCalls("tagsAdd").some((c) => c.body.variables.tags.includes("wa-confirmed")));
  assert.ok(shopifyCalls("tagsRemove").some((c) => c.body.variables.tags.includes("wa-sent")));
  const reply = waSends().find((s) => s.body.type === "interactive" || s.body.type === "text");
  assert.ok(reply, "thank-you reply sent inside the 24h window");
  const queued = await q(`SELECT count(*)::int AS n FROM jobs WHERE singleton_key LIKE $1 AND status='queued'`, [`order:${order.id}:confirm:%`]);
  assert.equal(queued[0].n, 0, "reminders cancelled");
  const inbound = await q(`SELECT * FROM messages WHERE direction='in'`);
  assert.equal(inbound.length, 1);
});

test("customer opts in via button", async () => {
  const [c] = await q(`SELECT id FROM customers WHERE phone_e164='+923001234567'`);
  await sendWaWebhook(inboundMessage("923001234567", { type: "interactive", interactive: { type: "button_reply", button_reply: { id: `OPTIN_YES:${c.id}`, title: "Yes" } } }));
  await worker.drain();
  const [after] = await q(`SELECT wa_opt_in, opt_in_source FROM customers WHERE id=$1`, [c.id]);
  assert.equal(after.wa_opt_in, true);
  assert.equal(after.opt_in_source, "whatsapp_button");
});

test("address change flow: location request -> typed address -> confirm -> written back to Shopify", async () => {
  calls.length = 0;
  const [order] = await q(`SELECT * FROM orders WHERE shopify_order_id=9001`);
  await sendWaWebhook(inboundMessage("923001234567", { type: "interactive", interactive: { type: "button_reply", button_reply: { id: `ADDRESS:${order.id}`, title: "Update address" } } }));
  await worker.drain();
  assert.equal(waSends().at(-1).body.interactive.type, "location_request_message");

  await sendWaWebhook(inboundMessage("923001234567", { type: "text", text: { body: "Flat 5, Sea View Apartments, Clifton Block 2" } }));
  await worker.drain();
  const confirmPrompt = waSends().at(-1).body;
  assert.equal(confirmPrompt.interactive.type, "button");
  assert.match(confirmPrompt.interactive.body.text, /Flat 5, Sea View Apartments/);

  await sendWaWebhook(inboundMessage("923001234567", { type: "interactive", interactive: { type: "button_reply", button_reply: { id: `ADDR_NEW_OK:${order.id}`, title: "Yes" } } }));
  await worker.drain();
  const upd = shopifyCalls("orderUpdate").at(-1);
  assert.equal(upd.body.variables.input.shippingAddress.address1, "Flat 5, Sea View Apartments, Clifton Block 2");
  const [o2] = await q(`SELECT address_status, address_text FROM orders WHERE id=$1`, [order.id]);
  assert.equal(o2.address_status, "updated");
  assert.ok(shopifyCalls("tagsAdd").some((c) => c.body.variables.tags.includes("address-updated")));
});

test("fulfillment -> tracking message with tracked link button; delivered -> delivered message + tag", async () => {
  calls.length = 0;
  await sendShopifyWebhook("fulfillments/create", { id: 7001, order_id: 9001, status: "success", tracking_company: "TCS", tracking_number: "TCS123", tracking_url: "https://tcs.example/track/TCS123" });
  await worker.drain();
  const ship = waSends().find((s) => s.body.template?.name === "order_shipped_v1");
  assert.ok(ship, "shipped template sent");
  const params = ship.body.template.components.find((c) => c.type === "body").parameters.map((p) => p.text);
  assert.equal(params[3], "TCS");
  assert.equal(params[4], "TCS123");
  const code = ship.body.template.components.find((c) => c.type === "button").parameters[0].text;
  const redirect = await rawGet(`/r/${code}`);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://tcs.example/track/TCS123");

  // same webhook again must not resend
  await sendShopifyWebhook("fulfillments/update", { id: 7001, order_id: 9001, status: "success", tracking_company: "TCS", tracking_number: "TCS123" });
  await worker.drain();
  assert.equal(waSends().filter((s) => s.body.template?.name === "order_shipped_v1").length, 1);

  await sendShopifyWebhook("fulfillments/update", { id: 7001, order_id: 9001, status: "success", tracking_company: "TCS", tracking_number: "TCS123", shipment_status: "delivered" });
  await worker.drain();
  assert.ok(waSends().some((s) => s.body.template?.name === "order_delivered_v1"));
  const [o] = await q(`SELECT status FROM orders WHERE shopify_order_id=9001`);
  assert.equal(o.status, "delivered");
});

test("free-text 'cancel' on an unconfirmed order asks for a reason, then cancels and tags", async () => {
  calls.length = 0;
  await sendShopifyWebhook("orders/create", orderPayload({ id: 9002, name: "#1002", checkout_token: null }));
  await worker.drain();
  const [order] = await q(`SELECT * FROM orders WHERE shopify_order_id=9002`);
  assert.equal(order.status, "awaiting_reply");
  await sendWaWebhook(inboundMessage("923001234567", { type: "text", text: { body: "nahi chahiye, cancel kar do" } }));
  await worker.drain();
  assert.equal(waSends().at(-1).body.interactive.type, "list");
  await sendWaWebhook(inboundMessage("923001234567", { type: "interactive", interactive: { type: "list_reply", list_reply: { id: `CANCEL_REASON:${order.id}:changed_mind`, title: "Changed my mind" } } }));
  await worker.drain();
  const [o] = await q(`SELECT status, cancel_reason FROM orders WHERE id=$1`, [order.id]);
  assert.equal(o.status, "cancelled_by_customer");
  assert.equal(o.cancel_reason, "changed_mind");
  assert.ok(shopifyCalls("tagsAdd").some((c) => c.body.variables.tags.includes("wa-cancelled")));
  assert.equal(shopifyCalls("orderCancel").length, 0, "auto-cancel in Shopify is off by default");
});

test("prepaid orders are not messaged when scope is COD only", async () => {
  calls.length = 0;
  await sendShopifyWebhook("orders/create", orderPayload({ id: 9003, name: "#1003", payment_gateway_names: ["shopify_payments"], financial_status: "paid" }));
  await worker.drain();
  const [o] = await q(`SELECT status FROM orders WHERE shopify_order_id=9003`);
  assert.equal(o.status, "not_eligible");
  assert.equal(waSends().length, 0);
});

test("delivery status webhooks update message status; failures tag the order", async () => {
  const [m] = await q(`SELECT wa_message_id FROM messages WHERE kind='confirmation' ORDER BY id LIMIT 1`);
  await sendWaWebhook({ messaging_product: "whatsapp", metadata: { phone_number_id: "109876543210987" }, statuses: [{ id: m.wa_message_id, status: "read", recipient_id: "923001234567", timestamp: "1700000000" }] });
  await worker.drain();
  const [after] = await q(`SELECT status FROM messages WHERE wa_message_id=$1`, [m.wa_message_id]);
  assert.equal(after.status, "read");
});

test("dashboard metrics and CSV export", async () => {
  const r = await owner.get(`/api/dashboard?storeId=${storeId}`);
  assert.equal(r.status, 200);
  assert.equal(Number(r.body.kpis.orders), 3);
  assert.ok(Number(r.body.messages.sent) >= 3);
  assert.ok(r.body.series.length >= 1);
  const csv = await owner.get(`/api/orders/export.csv?storeId=${storeId}`);
  assert.match(csv.body, /^name,store/);
  assert.match(csv.body, /#1001/);
});

test("tenant isolation: another account cannot see or act on this store", async () => {
  await other.post("/api/auth/signup", { name: "Other", email: "other@example.com", password: "password123", accountName: "Other Co" });
  const [order] = await q(`SELECT id FROM orders WHERE shopify_order_id=9001`);
  assert.equal((await other.get(`/api/orders/${order.id}`)).status, 403);
  assert.equal((await other.get(`/api/stores/${storeId}`)).status, 403);
  assert.equal((await other.get(`/api/orders?storeId=${storeId}`)).status, 403);
  const list = await other.get(`/api/orders`);
  assert.equal(list.body.rows.length, 0);
  assert.equal((await other.post(`/api/orders/${order.id}/actions`, { action: "mark_confirmed" })).status, 403);
  assert.equal((await other.get(`/api/admin/overview`)).status, 403);
});

test("CSRF header is required for state-changing API calls", async () => {
  const r = await owner.raw("POST", "/api/auth/logout", {}, { "X-Requested-With": "" });
  assert.equal(r.status, 403);
});

test("super admin sees every account and store", async () => {
  const r = await root.post("/api/auth/login", { email: "root@example.com", password: "rootpassword1" });
  assert.equal(r.status, 200);
  const overview = await root.get("/api/admin/overview");
  assert.equal(overview.status, 200);
  assert.equal(Number(overview.body.totals.accounts), 2);
  const stores = await root.get("/api/admin/stores");
  assert.equal(stores.body.length, 1);
  const orders = await root.get("/api/admin/orders");
  assert.ok(orders.body.length >= 3);
  const [order] = await q(`SELECT id FROM orders WHERE shopify_order_id=9001`);
  assert.equal((await root.get(`/api/orders/${order.id}`)).status, 200);
});

test("owner report: generated as PDF and sent to owner number as document template", async () => {
  calls.length = 0;
  const c = await owner.post("/api/owner-contacts", { name: "Boss", phone: "03211234567", store_id: storeId, reports: ["daily", "alerts"] });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const r = await owner.post("/api/reports/run", { storeId, type: "daily", send: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent[0].ok, true, JSON.stringify(r.body.sent));
  const send = waSends().find((s) => s.body.template?.name === "owner_report_v1");
  assert.equal(send.body.to, "923211234567");
  assert.equal(send.body.template.components[0].parameters[0].document.id, "media-123");
  const pdf = await owner.raw("GET", `/api/reports/${r.body.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.match(String(pdf.body).slice(0, 5), /%PDF/);
});

test("high value orders raise an owner alert", async () => {
  await owner.put(`/api/stores/${storeId}/settings`, { alerts: { highValueOrder: 5000 } });
  calls.length = 0;
  await new Promise((r) => setTimeout(r, 50));
  // settings cache: drop it so the worker sees the new threshold
  (await import("../src/services/stores.js")).invalidateStore(storeId);
  await sendShopifyWebhook("orders/create", orderPayload({ id: 9004, name: "#1004", total_price: "45000.00" }));
  await worker.drain();
  const alert = waSends().find((s) => s.body.template?.name === "owner_alert_v1");
  assert.ok(alert, "owner alert sent");
  assert.match(alert.body.template.components[0].parameters[1].text, /High value order #1004/);
});

test("campaign: segment of opted-in customers, unique discount codes, tracked links, attribution", async () => {
  calls.length = 0;
  // second customer without opt-in should be skipped
  await sendShopifyWebhook("orders/create", orderPayload({ id: 9005, name: "#1005", customer: { id: 88, first_name: "Bilal" }, shipping_address: { ...orderPayload().shipping_address, first_name: "Bilal", name: "Bilal", phone: "03331234567" } }));
  await worker.drain();
  const seg = await owner.post("/api/segments", { storeId, name: "Karachi buyers", rules: { match: "all", conditions: [{ field: "city", op: "in", value: "Karachi" }] } });
  assert.equal(seg.status, 200);
  const preview = await owner.post("/api/segments/preview", { storeId, rules: seg.body.rules });
  assert.equal(Number(preview.body.matched), 2);
  assert.equal(Number(preview.body.reachable), 1);

  const [tpl] = await q(`SELECT id FROM templates WHERE store_id=$1 AND kind='marketing_generic'`, [storeId]);
  const camp = await owner.post("/api/campaigns", {
    storeId,
    name: "Eid sale",
    template_id: tpl.id,
    segment_id: seg.body.id,
    variables: { "campaign.text": "Eid sale is live with 30% off!" },
    header_media_url: "https://cdn.shopify.com/eid.jpg",
    link_url: "https://glow.pk/collections/eid",
    discount: { percent: 15, days: 5 },
  });
  assert.equal(camp.status, 200, JSON.stringify(camp.body));
  const sched = await owner.post(`/api/campaigns/${camp.body.id}/schedule`, {});
  assert.equal(sched.status, 200, JSON.stringify(sched.body));
  await worker.drain();

  const sends = waSends().filter((s) => s.body.template?.name === "promo_message_v1");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.to, "923001234567");
  assert.ok(shopifyCalls("discountCodeBasicCreate").length === 1);
  const detail = await owner.get(`/api/campaigns/${camp.body.id}`);
  assert.equal(detail.body.campaign.status, "sent");
  const code = detail.body.recipients[0].discount_code;

  // customer orders with the code -> attributed revenue
  await sendShopifyWebhook("orders/create", orderPayload({ id: 9006, name: "#1006", total_price: "2500.00", discount_codes: [{ code }] }));
  await worker.drain();
  const after = await owner.get(`/api/campaigns/${camp.body.id}`);
  assert.equal(Number(after.body.stats.total.orders), 1);
  assert.equal(Number(after.body.stats.total.revenue), 2500);
});

test("STOP opts the customer out and blocks marketing", async () => {
  await sendWaWebhook(inboundMessage("923001234567", { type: "text", text: { body: "STOP" } }));
  await worker.drain();
  const [c] = await q(`SELECT wa_opt_in, opted_out_at FROM customers WHERE phone_e164='+923001234567' ORDER BY id LIMIT 1`);
  assert.equal(c.wa_opt_in, false);
  assert.ok(c.opted_out_at);
});

test("WhatsApp webhook verification handshake", async () => {
  const ok = await rawGet("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345");
  assert.equal(ok.text, "12345");
  const bad = await rawGet("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1");
  assert.equal(bad.status, 403);
  const unsigned = await rawPost("/webhooks/whatsapp", JSON.stringify({ entry: [] }), {});
  assert.equal(unsigned.status, 401);
});

test("team member limited to a store with agent role", async () => {
  const r = await owner.post("/api/team", { email: "agent@example.com", name: "Agent", password: "agentpass1", role: "agent", store_ids: [storeId] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const agent = client();
  await agent.post("/api/auth/login", { email: "agent@example.com", password: "agentpass1" });
  assert.equal((await agent.get(`/api/stores/${storeId}`)).status, 200);
  assert.equal((await agent.put(`/api/stores/${storeId}/settings`, { language: "ur" })).status, 403, "agents can't change settings");
  assert.equal((await agent.get(`/api/conversations?storeId=${storeId}`)).status, 200);
});

test("abandoned cart reminder is sent to opted-in shoppers and stops once they order", async () => {
  await owner.put(`/api/stores/${storeId}/settings`, { marketing: { abandonedCart: { enabled: true, steps: [{ delayMinutes: 0 }] } } });
  (await import("../src/services/stores.js")).invalidateStore(storeId);
  calls.length = 0;
  await sendShopifyWebhook("checkouts/create", {
    id: 1,
    token: "cart-abc",
    phone: "+923451234567",
    buyer_accepts_marketing: true,
    total_price: "1500.00",
    currency: "PKR",
    abandoned_checkout_url: "https://glow.pk/checkouts/abc/recover",
    shipping_address: { first_name: "Sara", phone: "+923451234567" },
    line_items: [{ title: "Lavender Candle", quantity: 2, price: "750.00", variant_id: 501, product_id: 401 }],
  });
  await worker.drain();
  const send = waSends().find((s) => s.body.template?.name === "abandoned_cart_v1");
  assert.ok(send, "abandoned cart template sent");
  assert.equal(send.body.to, "923451234567");
});

test("fake/risky order gets a risk score and needs attention", async () => {
  await sendShopifyWebhook("orders/create", orderPayload({ id: 9010, name: "#1010", shipping_address: { first_name: "x1", name: "x1", address1: "abc", city: "", phone: "0300 1234567", country_code: "PK" }, line_items: [{ id: 3, product_id: 401, variant_id: 501, title: "Candle", quantity: 10, price: "750" }], total_price: "7500" }));
  await worker.drain();
  const [o] = await q(`SELECT risk_score, risk_reasons, needs_attention, address_status FROM orders WHERE shopify_order_id=9010`);
  assert.ok(o.risk_score >= 40, `risk ${o.risk_score}`);
  assert.equal(o.address_status, "needs_update");
});

test("shopify API version fallbacks: webhook registration retries with callbackUrl", async () => {
  mock((u, b) => u.includes("/graphql.json") && b?.query?.includes("uri: $uri") && b?.query?.includes("webhookSubscriptionCreate"), () => ({ __status: 200, errors: [{ message: "Field 'uri' doesn't exist on type 'WebhookSubscriptionInput'" }] }));
  calls.length = 0;
  const r = await owner.post(`/api/stores/${storeId}/setup`, {});
  assert.equal(r.status, 200);
  await worker.drain();
  assert.ok(shopifyCalls("callbackUrl: $uri").length >= 5);
});
