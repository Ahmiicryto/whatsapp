import "./env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setup, teardown, client, worker, waSends, calls, sendShopifyWebhook, q, shopifyHmac } from "./helpers.js";
import { Cron } from "../src/queue/queue.js";
import handler from "../api/index.js";

const owner = client();
let storeId;

before(async () => {
  await setup();
  await owner.post("/api/auth/signup", { name: "O", email: "s@example.com", password: "password123", accountName: "A" });
  const s = await owner.post("/api/stores", { shopDomain: "glow", accessToken: "shpat_1234567890", webhookSecret: "shpss_store_secret" });
  storeId = s.body.id;
  await owner.post(`/api/stores/${storeId}/whatsapp`, { phoneNumberId: "109876543210987", wabaId: "WABA1", accessToken: "EAAG-test-token-123456789" });
  await worker.drain();
  await q(`UPDATE templates SET status='APPROVED' WHERE store_id=$1`, [storeId]);
  await owner.put(`/api/stores/${storeId}/settings`, { confirmation: { delayMinutes: 0 } });
});
after(teardown);

test("Vercel entry handler serves the app", async () => {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const res = await new Promise((resolve) => http.get(`http://127.0.0.1:${server.address().port}/healthz`, resolve));
  let body = "";
  for await (const c of res) body += c;
  server.close();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(body), { ok: true });
});

test("Vercel entry handler keeps raw bytes for webhook HMAC checks", async () => {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const raw = JSON.stringify({ id: 7100, name: "#7100", line_items: [], total_price: "10.00" });
  const post = (hmac) =>
    fetch(`http://127.0.0.1:${server.address().port}/webhooks/shopify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Topic": "orders/updated", "X-Shopify-Shop-Domain": "glow.myshopify.com", "X-Shopify-Hmac-Sha256": hmac, "X-Shopify-Webhook-Id": `w-${hmac.length}` },
      body: raw,
    });
  const ok = await post(shopifyHmac("shpss_store_secret", raw));
  const bad = await post(shopifyHmac("wrong", raw));
  server.close();
  assert.equal(ok.status, 200);
  assert.equal(bad.status, 401);
});

test("cron tick requires the secret", async () => {
  const r = await owner.get("/api/cron/tick");
  assert.equal(r.status, 401);
});

test("cron tick processes queued work (new order -> WhatsApp confirmation)", async () => {
  calls.length = 0;
  await sendShopifyWebhook("orders/create", {
    id: 7001, name: "#7001", created_at: new Date().toISOString(), payment_gateway_names: ["Cash on Delivery (COD)"],
    total_price: "999.00", currency: "PKR",
    shipping_address: { first_name: "Ali", name: "Ali", address1: "House 1, Street 2", city: "Lahore", country_code: "PK", phone: "03001112233" },
    line_items: [{ id: 1, product_id: 401, variant_id: 501, title: "Candle", quantity: 1, price: "999.00" }],
  });
  for (let i = 0; i < 5; i++) {
    const r = await owner.raw("GET", "/api/cron/tick", undefined, { Authorization: "Bearer cron-secret-123" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (waSends().length) break;
  }
  const [o] = await q(`SELECT status FROM orders WHERE shopify_order_id=7001`);
  assert.equal(o.status, "awaiting_reply");
  assert.equal(waSends()[0].body.template.name, "order_confirmation_v1");
});

test("cron runs each entry once per period even if ticks arrive late", async () => {
  await q(`DELETE FROM cron_runs`);
  await q(`DELETE FROM jobs WHERE name='cron.test'`);
  const cron = new Cron([{ name: "t15", job: "cron.test", everyMinutes: 15 }, { name: "hourly", job: "cron.test2", atMinute: 7 }]);
  await cron.tick(new Date("2026-10-25T10:03:00Z")); // late tick inside the 10:00-10:15 period
  await q(`UPDATE jobs SET status='done' WHERE name LIKE 'cron.test%'`);
  await cron.tick(new Date("2026-10-25T10:09:00Z")); // same period -> no new run; hourly due (>= :07)
  await q(`UPDATE jobs SET status='done' WHERE name LIKE 'cron.test%'`);
  await cron.tick(new Date("2026-10-25T10:16:00Z")); // next period
  const runs = await q(`SELECT name, slot FROM cron_runs ORDER BY created_at`);
  assert.deepEqual(runs.map((r) => r.name), ["t15", "hourly", "t15"]);
});
