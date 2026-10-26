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

let trackStatus = "Booked";
let pxCounter = 0;
async function runDelayed() {
  await q(`UPDATE jobs SET run_at=now() WHERE status='queued'`);
  await worker.drain();
}

before(async () => {
  await setup();
  mock((u) => u.includes("api.postex.pk") && u.includes("get-operational-city"), () => ({ statusCode: "200", dist: [{ operationalCityName: "Islamabad" }] }));
  mock((u) => u.includes("api.postex.pk") && u.includes("create-order"), () => ({ statusCode: "200", dist: { trackingNumber: `PX${++pxCounter}` } }));
  mock((u) => u.includes("api.postex.pk") && u.includes("track-order"), () => ({ statusCode: "200", dist: { transactionStatus: trackStatus, transactionStatusHistory: [{ transactionStatusMessage: trackStatus, updatedAt: new Date().toISOString() }] } }));
  mock((u, b) => u.includes("/graphql.json") && b?.query?.includes("fulfillmentOrders"), () => ({ data: { order: { fulfillmentOrders: { nodes: [{ id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" }] } } } }));
  mock((u, b) => u.includes("/graphql.json") && b?.query?.includes("fulfillmentCreate"), () => ({ data: { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/9" }, userErrors: [] } } }));
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

// ---------------------------------------------------------------- phase 2: couriers, recovery, COD, fraud, profit

let courierId;
test("add a PostEx courier and test the connection", async () => {
  const providers = await owner.get("/api/couriers/providers");
  assert.ok(providers.body.some((p) => p.id === "postex") && providers.body.some((p) => p.id === "custom"));
  const missing = await owner.post(`/api/stores/${storeId}/couriers`, { provider: "postex", fields: {} });
  assert.equal(missing.status, 400);
  const c = await owner.post(`/api/stores/${storeId}/couriers`, { provider: "postex", fields: { token: "px-token" }, isDefault: true });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.fields.token, "••••••", "secrets are never sent back");
  assert.equal(c.body.is_default, true);
  courierId = c.body.id;
  const t = await owner.post(`/api/stores/${storeId}/couriers/${courierId}/test`, {});
  assert.equal(t.body.ok, true);
});

let shipmentId;
let bookedOrder;
test("book a confirmed order, fulfil it in Shopify and send tracking on WhatsApp", async () => {
  bookedOrder = await newOrder();
  calls.length = 0;
  await customerSays("1"); // numbered menu: 1 = Confirm
  assert.equal((await q(`SELECT status FROM orders WHERE id=$1`, [bookedOrder.id]))[0].status, "confirmed");
  const toBook = await owner.get(`/api/shipments?tab=to_book`);
  assert.ok(toBook.body.rows.some((r) => r.order_id === bookedOrder.id));
  const b = await owner.post(`/api/orders/${bookedOrder.id}/book`, {});
  assert.equal(b.status, 200, JSON.stringify(b.body));
  shipmentId = b.body.id;
  assert.match(b.body.tracking_number, /^PX\d+$/);
  assert.equal(Number(b.body.cod_amount), 2500);
  const req = calls.find((c) => c.url.includes("create-order"));
  assert.equal(req.headers.token, "px-token");
  assert.equal(req.body.customerPhone, "03005556666");
  assert.equal(req.body.cityName, "Islamabad");
  await worker.drain();
  assert.ok(gwSends().some((c) => (c.body.text || "").includes(b.body.tracking_number)), "tracking number sent on WhatsApp");
  assert.ok(calls.some((c) => c.body?.query?.includes("fulfillmentCreate")), "order fulfilled in Shopify");
  const again = await owner.post(`/api/orders/${bookedOrder.id}/book`, {});
  assert.equal(again.body.id, shipmentId, "booking is idempotent");
});

test("failed delivery: customer is asked on WhatsApp and can ask for redelivery", async () => {
  trackStatus = "Delivery Attempted - Consignee not available";
  calls.length = 0;
  const s = await owner.post(`/api/shipments/${shipmentId}/sync`, {});
  assert.equal(s.body.status, "attempted");
  await worker.drain();
  assert.match(lastText(), /could not deliver/);
  await customerSays("1"); // 1 = Deliver again
  const sh = (await q(`SELECT reschedule FROM shipments WHERE id=$1`, [shipmentId]))[0];
  assert.equal(sh.reschedule.choice, "redeliver");
  assert.match(lastText(), /deliver order .* again/);
  const n = await owner.get("/api/notifications");
  assert.ok(n.body.rows.some((r) => r.kind === "shipment.recovery"));
});

test("delivered parcels show up as COD to collect and can be settled", async () => {
  trackStatus = "Delivered";
  await owner.post(`/api/shipments/${shipmentId}/sync`, {});
  await worker.drain();
  assert.equal((await q(`SELECT status FROM orders WHERE id=$1`, [bookedOrder.id]))[0].status, "delivered");
  const sum = await owner.get("/api/shipments/summary");
  assert.equal(Number(sum.body.cod_due), 2500);
  const cod = await owner.get("/api/shipments?tab=cod");
  assert.equal(cod.body.rows.length, 1);
  const settle = await owner.post("/api/shipments/settle", { ids: [shipmentId], ref: "PostEx payout 12" });
  assert.equal(settle.body.count, 1);
  assert.equal((await owner.get("/api/shipments?tab=cod")).body.rows.length, 0);
});

test("CSV import updates statuses and settles cash by tracking number", async () => {
  const o = await newOrder();
  const sh = (await owner.post(`/api/orders/${o.id}/book`, { force: true })).body;
  const csv = `Tracking Number,Status,COD Amount\n${sh.tracking_number},Delivered,2500\nUNKNOWN1,Delivered,10\n`;
  const r = await owner.post("/api/shipments/import", { csv });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.updated, 1);
  assert.equal(r.body.settled, 1);
  assert.deepEqual(r.body.unmatched, ["UNKNOWN1"]);
});

test("numbers that keep returning parcels are blocked and flagged on the next order", async () => {
  const phone = { shipping_address: { first_name: "Faraz", name: "Faraz Ali", address1: "Street 1", city: "Lahore", country_code: "PK", phone: "03217778888" } };
  for (let i = 0; i < 2; i++) {
    const o = await newOrder(phone);
    const sh = (await owner.post(`/api/orders/${o.id}/book`, { force: true })).body;
    assert.ok(sh.id, JSON.stringify(sh));
    await owner.put(`/api/shipments/${sh.id}/status`, { status: "returned" });
  }
  const list = await owner.get("/api/fraud/blocklist");
  assert.ok(list.body.some((b) => b.phone_e164 === "+923217778888" && b.source === "auto_returns"));
  const rep = await owner.get("/api/fraud/lookup?phone=03217778888");
  assert.equal(rep.body.level, "blocked");
  assert.equal(rep.body.returned, 2);
  const next = await newOrder(phone);
  const row = (await q(`SELECT risk_score, shopify_tags, needs_attention FROM orders WHERE id=$1`, [next.id]))[0];
  assert.equal(row.risk_score, 100);
  assert.ok(row.shopify_tags.includes("blocked-number"));
  const blockedBook = await owner.post(`/api/orders/${next.id}/book`, {});
  assert.equal(blockedBook.status, 400);
});

test("advance payment: asked after confirming, booking waits until it is marked paid", async () => {
  await owner.put(`/api/stores/${storeId}/settings`, { advance: { enabled: true, mode: "all_cod", minTotal: 0, type: "fixed", amount: 300 }, couriers: { autoBook: true } });
  const phone = { shipping_address: { first_name: "Hina", name: "Hina Shah", address1: "Block B", city: "Karachi", country_code: "PK", phone: "03339990000" } };
  const o = await newOrder(phone);
  calls.length = 0;
  await customerSays("1", "923339990000");
  await worker.drain();
  const row = (await q(`SELECT advance_status, advance_amount FROM orders WHERE id=$1`, [o.id]))[0];
  assert.equal(row.advance_status, "requested");
  assert.equal(Number(row.advance_amount), 300);
  assert.match(lastText(), /advance of/);
  assert.equal((await owner.post(`/api/orders/${o.id}/book`, {})).status, 400, "booking waits for the advance");
  await gatewayEvent([{ type: "message", session, from: "923339990000", wamid: "IMG1", kind: "image", text: "", media: { base64: Buffer.from("x").toString("base64"), mime: "image/jpeg" } }]);
  await worker.drain();
  assert.ok((await owner.get("/api/notifications")).body.rows.some((n) => n.kind === "advance.screenshot"));
  await owner.post(`/api/orders/${o.id}/advance/paid`, {});
  await runDelayed();
  const sh = (await q(`SELECT * FROM shipments WHERE order_id=$1`, [o.id]))[0];
  assert.ok(sh, "booked automatically after the advance was paid");
  assert.equal(Number(sh.cod_amount), 2200, "courier collects the rest");
  await owner.put(`/api/stores/${storeId}/settings`, { advance: { enabled: false }, couriers: { autoBook: false } });
});

test("profit report subtracts product cost, courier fees, returns and ad spend", async () => {
  await q(`INSERT INTO products (store_id, shopify_product_id, title, variants) VALUES ($1, 401, 'Lavender Candle', '[]') ON CONFLICT DO NOTHING`, [storeId]);
  const p = (await q(`SELECT id FROM products WHERE store_id=$1 AND shopify_product_id=401`, [storeId]))[0];
  assert.equal((await owner.put(`/api/products/${p.id}/cost`, { cost: 1000 })).status, 200);
  await owner.post("/api/ad-spend", { storeId, day: new Date().toISOString().slice(0, 10), channel: "meta", amount: 500 });
  const r = await owner.get(`/api/profit?storeId=${storeId}&days=7`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = r.body.totals;
  assert.ok(t.revenue > 0);
  assert.ok(t.cogs >= 1000);
  assert.equal(t.ads, 500);
  assert.ok(t.returned >= 2);
  assert.equal(Math.round(t.profit), Math.round(t.revenue - t.cogs - t.shipping - t.returnCost - t.fees - t.packaging - t.ads));
  assert.ok(r.body.products.some((x) => Number(x.product_id) === 401));
});
