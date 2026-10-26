import "./env.js";
import "./features-env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setup, teardown, client, worker, calls, mock, rawPost, sendShopifyWebhook, q } from "./helpers.js";

const owner = client();
const root = client();
let storeId;
let gwCounter = 0;
const gwSends = () => calls.filter((c) => c.url.startsWith("https://gw.example.com/sessions/") && c.url.endsWith("/send"));
const lastText = () => {
  const s = gwSends();
  const b = s[s.length - 1]?.body || {};
  return b.text || b.caption || "";
};

export async function gatewayEvent(events) {
  const raw = JSON.stringify({ events });
  return rawPost("/webhooks/gateway", raw, { "X-Gateway-Signature": crypto.createHmac("sha256", "gwsecret").update(raw).digest("hex") });
}
let session;
async function customerSays(text, from = "923005556666") {
  await gatewayEvent([{ type: "message", session, from, wamid: `IN${crypto.randomUUID()}`, kind: "text", text, profileName: "Sana" }]);
  await worker.drain();
}

let orderSeq = 9100;
export async function newOrder(extra = {}) {
  const id = ++orderSeq;
  await sendShopifyWebhook("orders/create", {
    id, name: `#${id}`, created_at: new Date().toISOString(), payment_gateway_names: ["Cash on Delivery (COD)"], total_price: "2500.00", currency: "PKR",
    shipping_address: { first_name: "Sana", name: "Sana Malik", address1: "House 9, Street 3, F-7", city: "Islamabad", country_code: "PK", phone: "03005556666" },
    line_items: [{ id: 1, product_id: 401, variant_id: 777, title: "Lavender Candle", variant_title: "Large", quantity: 1, price: "2500.00" }],
    ...extra,
  }, { domain: "suite.myshopify.com" });
  await worker.drain();
  return (await q(`SELECT * FROM orders WHERE shopify_order_id=$1`, [id]))[0];
}

before(async () => {
  await setup();
  mock((u) => /gw\.example\.com\/sessions\/[^/]+\/start$/.test(u), () => ({ status: "qr", qr: "data:image/png;base64,QR" }));
  mock((u, _b, m) => m === "GET" && /gw\.example\.com\/sessions\/[^/]+$/.test(u), () => ({ status: "connected", phone: "+923001110000", name: "Glow" }));
  mock((u) => /gw\.example\.com\/sessions\/[^/]+\/send$/.test(u), () => ({ id: `GW${++gwCounter}` }));
  await owner.post("/api/auth/signup", { name: "Owner", email: "suite@example.com", password: "password123", accountName: "Suite Co" });
  const s = await owner.post("/api/stores", { shopDomain: "suite", accessToken: "shpat_1234567890", webhookSecret: "shpss_store_secret" });
  storeId = s.body.id;
  await owner.post(`/api/stores/${storeId}/whatsapp/qr`, {});
  await owner.get(`/api/stores/${storeId}/whatsapp/qr`);
  await owner.put(`/api/stores/${storeId}/settings`, { confirmation: { delayMinutes: 0 }, quietHours: { enabled: false } });
  await worker.drain();
  session = (await q(`SELECT gateway_session FROM whatsapp_numbers WHERE provider='gateway' ORDER BY id DESC LIMIT 1`))[0].gateway_session;
  await root.post("/api/auth/login", { email: "root@example.com", password: "rootpassword1" });
});
after(teardown);


export { owner, root, lastText, gwSends, customerSays };

// ---------------------------------------------------------------- phase 1

test("global search finds orders by phone number and order name", async () => {
  const o = await newOrder();
  const byPhone = await owner.get(`/api/search?q=0300 5556666`);
  assert.equal(byPhone.status, 200);
  assert.ok(byPhone.body.results.some((r) => r.type === "order" && r.id === o.id), JSON.stringify(byPhone.body));
  const byName = await owner.get(`/api/search?q=${encodeURIComponent(o.name)}`);
  assert.ok(byName.body.results.some((r) => r.link === `/orders/${o.id}`));
});

test("chats that need a person create one notification, and can be marked read", async () => {
  await customerSays("I need to talk to someone about a refund");
  await customerSays("hello??");
  const n = await owner.get("/api/notifications");
  const human = n.body.rows.filter((r) => r.kind === "inbox.human");
  assert.equal(human.length, 1, "notified once, not on every message");
  assert.ok(n.body.unread >= 1);
  await owner.post("/api/notifications/read", {});
  assert.equal((await owner.get("/api/notifications")).body.unread, 0);
});

test("onboarding checklist reflects setup progress", async () => {
  const r = await owner.get("/api/onboarding");
  const step = (id) => r.body.steps.find((s) => s.id === id);
  assert.equal(step("store").done, true);
  assert.equal(step("whatsapp").done, true);
  assert.equal(step("courier").done, false);
});
