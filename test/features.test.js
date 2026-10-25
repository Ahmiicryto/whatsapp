import "./env.js";
import "./features-env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setup, teardown, client, worker, calls, mock, rawPost, sendShopifyWebhook, q, shopifyCalls } from "./helpers.js";

const owner = client();
const root = client();
let storeId;
let gwSends = () => calls.filter((c) => c.url.startsWith("https://gw.example.com/sessions/") && c.url.endsWith("/send"));
let gwCounter = 0;

async function gatewayEvent(events) {
  const raw = JSON.stringify({ events });
  return rawPost("/webhooks/gateway", raw, { "X-Gateway-Signature": crypto.createHmac("sha256", "gwsecret").update(raw).digest("hex") });
}

before(async () => {
  await setup();
  mock((u) => /gw\.example\.com\/sessions\/[^/]+\/start$/.test(u), () => ({ status: "qr", qr: "data:image/png;base64,QRDATA" }));
  mock((u, _b, m) => m === "GET" && /gw\.example\.com\/sessions\/[^/]+$/.test(u), () => ({ status: "connected", phone: "+923001110000", name: "Glow" }));
  mock((u) => /gw\.example\.com\/sessions\/[^/]+\/send$/.test(u), () => ({ id: `GW${++gwCounter}` }));
  mock((u, b) => u.includes("/graphql.json") && b?.query?.includes("products(first"), () => ({
    data: { products: { pageInfo: { hasNextPage: false }, nodes: [{
      id: "gid://shopify/Product/401", title: "Lavender Candle", handle: "lavender-candle", status: "ACTIVE", productType: "Candles", vendor: "Glow", tags: ["bestseller"],
      onlineStoreUrl: "https://glow.pk/products/lavender-candle", totalInventory: 42,
      featuredMedia: { preview: { image: { url: "https://cdn.shopify.com/lavender.jpg" } } },
      media: { nodes: [{ preview: { image: { url: "https://cdn.shopify.com/lavender.jpg" } } }, { preview: { image: { url: "https://cdn.shopify.com/lavender-2.jpg" } } }] },
      priceRangeV2: { minVariantPrice: { amount: "750.0", currencyCode: "PKR" }, maxVariantPrice: { amount: "900.0" } },
      variants: { nodes: [{ legacyResourceId: "777", title: "Large", sku: "CAN-L", price: "900.0", inventoryQuantity: 10, image: { url: "https://cdn.shopify.com/lavender-large.jpg" } }] },
    }] } },
  }));
  mock((u) => u.includes("/oauth/access_token?") && u.includes("graph.facebook.com"), () => ({ access_token: "EAAG-signup-token-xyz" }));

  await owner.post("/api/auth/signup", { name: "Owner", email: "f@example.com", password: "password123", accountName: "Glow Group" });
  const s = await owner.post("/api/stores", { shopDomain: "glow", accessToken: "shpat_1234567890", webhookSecret: "shpss_store_secret" });
  storeId = s.body.id;
  await worker.drain();
});
after(teardown);

test("product catalog syncs with images, variants and stock", async () => {
  const r = await owner.get(`/api/products?storeId=${storeId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 1);
  const p = r.body.rows[0];
  assert.equal(p.image_url, "https://cdn.shopify.com/lavender.jpg");
  assert.equal(p.images.length, 2);
  assert.equal(p.variants[0].image, "https://cdn.shopify.com/lavender-large.jpg");
  assert.equal(p.inventory, 42);
  const search = await owner.get(`/api/products?storeId=${storeId}&q=CAN-L`);
  assert.equal(search.body.total, 1, "search by SKU");
});

test("connect WhatsApp by scanning a QR code (gateway)", async () => {
  const [before] = await q(`SELECT whatsapp_number_id FROM stores WHERE id=$1`, [storeId]);
  const start = await owner.post(`/api/stores/${storeId}/whatsapp/qr`, {});
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.status, "qr");
  assert.match(start.body.qr, /^data:image\/png/);
  const [during] = await q(`SELECT whatsapp_number_id FROM stores WHERE id=$1`, [storeId]);
  assert.equal(during.whatsapp_number_id, before.whatsapp_number_id, "current number keeps working until the phone is scanned");
  const status = await owner.get(`/api/stores/${storeId}/whatsapp/qr`);
  assert.equal(status.body.status, "connected");
  await worker.drain();
  const detail = await owner.get(`/api/stores/${storeId}`);
  assert.equal(detail.body.whatsapp.provider, "gateway");
  assert.equal(detail.body.whatsapp.display_number, "+923001110000");
  const tpl = await q(`SELECT count(*)::int n FROM templates WHERE store_id=$1`, [storeId]);
  assert.ok(tpl[0].n >= 10, "default templates created (rendered locally, no Meta approval needed)");
});

test("QR number: order confirmation goes out with product photo and a numbered menu; replying 1 confirms", async () => {
  await owner.put(`/api/stores/${storeId}/settings`, { confirmation: { delayMinutes: 0 } });
  calls.length = 0;
  await sendShopifyWebhook("orders/create", {
    id: 8801, name: "#8801", created_at: new Date().toISOString(), payment_gateway_names: ["Cash on Delivery (COD)"], total_price: "900.00", currency: "PKR",
    shipping_address: { first_name: "Sana", name: "Sana Malik", address1: "House 9, Street 3, F-7", city: "Islamabad", country_code: "PK", phone: "03005556666" },
    line_items: [{ id: 1, product_id: 401, variant_id: 777, title: "Lavender Candle", variant_title: "Large", quantity: 1, price: "900.00" }],
  });
  await worker.drain();
  const sends = gwSends();
  assert.equal(sends.length, 1, JSON.stringify(calls.map((c) => c.url)));
  const body = sends[0].body;
  assert.equal(body.to, "923005556666");
  assert.equal(body.image.link, "https://cdn.shopify.com/lavender-large.jpg", "variant photo from the synced catalog");
  assert.match(body.caption, /Sana/);
  assert.match(body.caption, /1️⃣ Confirm order/);
  assert.match(body.caption, /3️⃣ Cancel order/);
  assert.equal(shopifyCalls("nodes(ids").length, 0, "no extra Shopify image lookup needed");

  const session = (await q(`SELECT gateway_session FROM whatsapp_numbers WHERE provider='gateway'`))[0].gateway_session;
  const r = await gatewayEvent([{ type: "message", session, from: "923005556666", wamid: "IN1", kind: "text", text: "1", profileName: "Sana" }]);
  assert.equal(r.status, 200);
  await worker.drain();
  const [o] = await q(`SELECT status FROM orders WHERE shopify_order_id=8801`);
  assert.equal(o.status, "confirmed");
  assert.ok(gwSends().length >= 2, "thank-you sent");

  await gatewayEvent([{ type: "status", session, wamid: "GW1", status: "read" }]);
  await worker.drain();
  const [m] = await q(`SELECT status FROM messages WHERE wa_message_id='GW1'`);
  assert.equal(m.status, "read");
});

test("gateway webhooks must be signed", async () => {
  const r = await rawPost("/webhooks/gateway", JSON.stringify({ events: [] }), { "X-Gateway-Signature": "bad" });
  assert.equal(r.status, 401);
});

test("store owner sets their WhatsApp number and gets the daily report for all their stores", async () => {
  const p = await owner.put("/api/profile", { name: "Owner", phone: "0321 7654321", dailyReport: true, alerts: true });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const me = await owner.get("/api/profile");
  assert.equal(me.body.phone_e164, "+923217654321");
  assert.equal(me.body.dailyReport, true);
  calls.length = 0;
  const r = await owner.post("/api/reports/run", { storeId: null, type: "daily", send: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent[0].ok, true, JSON.stringify(r.body.sent));
  const doc = gwSends().find((c) => c.body.document);
  assert.equal(doc.body.to, "923217654321");
  assert.equal(doc.body.document.mime, "application/pdf");
  assert.ok(doc.body.document.base64.length > 1000, "PDF attached");

  calls.length = 0;
  const t = await owner.post("/api/profile/test-report", {});
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(gwSends().find((c) => c.body.document).body.to, "923217654321", "'send me a sample' goes only to me");
});

test("super admin gets the platform daily report on WhatsApp", async () => {
  await root.post("/api/auth/login", { email: "root@example.com", password: "rootpassword1" });
  const s = await root.put("/api/admin/platform-report", { enabled: true, phone: "03001234567", time: "22:00", senderStoreId: null });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  calls.length = 0;
  const r = await root.post("/api/admin/platform-report/send", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const doc = gwSends().find((c) => c.body.document);
  assert.equal(doc.body.to, "923001234567");
  assert.match(doc.body.caption, /Platform daily report/);
  const view = await root.get("/api/admin/platform-report");
  assert.equal(view.body.history.length, 1);
  assert.equal((await owner.get("/api/admin/platform-report")).status, 403);
});

test("official QR connect (Meta Embedded Signup) links a Cloud API number", async () => {
  const s2 = await owner.post("/api/stores", { shopDomain: "bloom", accessToken: "shpat_0987654321", webhookSecret: "shpss_bloom_secret" });
  const r = await owner.post(`/api/stores/${s2.body.id}/whatsapp/embedded`, { code: "signup-code-123", phoneNumberId: "109876543210000", wabaId: "WABA9", coexistence: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [n] = await q(`SELECT provider, waba_id FROM whatsapp_numbers WHERE phone_number_id='109876543210000'`);
  assert.equal(n.provider, "cloud");
  assert.equal(n.waba_id, "WABA9");
  assert.equal(calls.filter((c) => c.url.endsWith("/register")).length, 0, "coexistence numbers are not re-registered");
  const me = await owner.get("/api/auth/me");
  assert.equal(me.body.features.metaSignupConfigId, "cfg123");
  assert.equal(me.body.features.qrGateway, true);
});
