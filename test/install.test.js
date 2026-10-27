import "./env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setup, teardown, client, worker, mock, rawGet, q, shopifyCalls } from "./helpers.js";

const signed = (params) => {
  const msg = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  const hmac = crypto.createHmac("sha256", "shopify-app-secret").update(msg).digest("hex");
  return new URLSearchParams({ ...params, hmac }).toString();
};

before(async () => {
  await setup();
  mock((u) => /\/admin\/oauth\/access_token$/.test(u), () => ({ access_token: "shpat_oauth_token_123", scope: "read_orders,write_orders" }));
});
after(teardown);

function stateFrom(location) {
  const u = new URL(location);
  assert.equal(u.pathname, "/admin/oauth/authorize");
  assert.equal(u.searchParams.get("client_id"), "test-key");
  assert.equal(u.searchParams.get("redirect_uri"), "https://app.example.com/shopify/callback");
  return u.searchParams.get("state");
}

test("install from Shopify while signed out -> approve -> claim after login", async () => {
  const r = await rawGet(`/shopify/install?${signed({ shop: "newshop.myshopify.com", timestamp: "1700000000" })}`);
  assert.equal(r.status, 302);
  const state = stateFrom(r.headers.get("location"));

  const cb = await rawGet(`/shopify/callback?${signed({ code: "abc", shop: "newshop.myshopify.com", state, timestamp: "1700000001" })}`);
  assert.equal(cb.status, 302);
  const loc = cb.headers.get("location");
  assert.match(loc, /^\/claim-store\?token=/);
  const token = decodeURIComponent(loc.split("token=")[1]);
  assert.equal((await q(`SELECT count(*)::int n FROM stores`))[0].n, 0, "not linked before someone claims it");

  const owner = client();
  await owner.post("/api/auth/signup", { name: "Owner", email: "claim@example.com", password: "password123", accountName: "Claim Co" });
  const info = await owner.get(`/api/stores/claim/${encodeURIComponent(token)}`);
  assert.equal(info.body.shop, "newshop.myshopify.com");
  const claimed = await owner.post("/api/stores/claim", { token });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  await worker.drain();
  const [store] = await q(`SELECT account_id, connection_type, shopify_domain FROM stores WHERE id=$1`, [claimed.body.storeId]);
  assert.equal(store.connection_type, "oauth");
  assert.ok(shopifyCalls("webhookSubscriptionCreate").length >= 5, "setup ran (webhooks registered)");
  assert.equal((await owner.post("/api/stores/claim", { token })).status, 404, "a claim link works once");
});

test("install while signed in links the store to your account automatically", async () => {
  const owner = client();
  await owner.post("/api/auth/signup", { name: "B", email: "b@example.com", password: "password123", accountName: "B Co" });
  const r = await rawGet(`/shopify/install?shop=bstore`, { Cookie: owner.cookie() });
  assert.equal(r.status, 302);
  const [st] = await q(`SELECT state, account_id FROM oauth_states WHERE shop='bstore.myshopify.com'`);
  assert.ok(st.account_id, "account remembered for the install");
  const cb = await rawGet(`/shopify/callback?${signed({ code: "abc", shop: "bstore.myshopify.com", state: st.state, timestamp: "1700000002" })}`, { Cookie: owner.cookie() });
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get("location"), /^\/stores\/\d+\?connected=1$/);
  const [store] = await q(`SELECT a.name FROM stores s JOIN accounts a ON a.id=s.account_id WHERE s.shopify_domain='bstore.myshopify.com'`);
  assert.equal(store.name, "B Co");
});

test("opening the app from Shopify admin for a linked store goes to the portal (and breaks out of the iframe)", async () => {
  const r = await rawGet(`/shopify/install?${signed({ shop: "bstore.myshopify.com", timestamp: "1700000003" })}`);
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /\/stores\/\d+$/);
  const embedded = await rawGet(`/shopify/install?${signed({ shop: "bstore.myshopify.com", timestamp: "1700000004", embedded: "1", host: "abc" })}`);
  assert.equal(embedded.status, 200);
  assert.match(embedded.text, /target="_top"/);
  assert.match(embedded.headers.get("content-security-policy"), /admin\.shopify\.com/);
});

test("reinstall after uninstall returns the store to its account without claiming", async () => {
  await q(`UPDATE stores SET status='disconnected', shopify_token_enc=NULL WHERE shopify_domain='bstore.myshopify.com'`);
  const r = await rawGet(`/shopify/install?${signed({ shop: "bstore.myshopify.com", timestamp: "1700000005" })}`);
  const state = stateFrom(r.headers.get("location"));
  const cb = await rawGet(`/shopify/callback?${signed({ code: "abc", shop: "bstore.myshopify.com", state, timestamp: "1700000006" })}`);
  assert.match(cb.headers.get("location"), /^\/stores\/\d+\?connected=1$/);
  const [s] = await q(`SELECT status FROM stores WHERE shopify_domain='bstore.myshopify.com'`);
  assert.equal(s.status, "active");
});

test("forged Shopify requests are rejected", async () => {
  const bad = await rawGet(`/shopify/install?shop=evil.myshopify.com&timestamp=1&hmac=deadbeef`);
  assert.equal(bad.status, 400);
  const cb = await rawGet(`/shopify/callback?shop=bstore.myshopify.com&code=x&state=y&hmac=bad`);
  assert.equal(cb.status, 400);
});

test("a second store can use its own Shopify app (custom distribution is one store per app)", async () => {
  const owner = client();
  await owner.post("/api/auth/signup", { name: "C", email: "c@example.com", password: "password123", accountName: "C Co" });
  const saved = await owner.post("/api/stores/shopify-app", { shopDomain: "cstore", clientId: "own-client-id-123", clientSecret: "own-client-secret-456" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const r = await rawGet(saved.body.installUrl, { Cookie: owner.cookie() });
  const u = new URL(r.headers.get("location"));
  assert.equal(u.searchParams.get("client_id"), "own-client-id-123", "uses the store's own app");
  const state = u.searchParams.get("state");
  const ownSigned = (params) => {
    const msg = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
    return new URLSearchParams({ ...params, hmac: crypto.createHmac("sha256", "own-client-secret-456").update(msg).digest("hex") }).toString();
  };
  const bad = await rawGet(`/shopify/callback?${signed({ code: "abc", shop: "cstore.myshopify.com", state, timestamp: "1700000010" })}`);
  assert.equal(bad.status, 400, "platform secret doesn't sign for the store's own app");
  const cb = await rawGet(`/shopify/callback?${ownSigned({ code: "abc", shop: "cstore.myshopify.com", state, timestamp: "1700000011" })}`, { Cookie: owner.cookie() });
  assert.equal(cb.status, 302, cb.text);
  assert.match(cb.headers.get("location"), /^\/stores\/\d+\?connected=1$/);
  const [store] = await q(`SELECT webhook_secret_enc IS NOT NULL AS own_secret FROM stores WHERE shopify_domain='cstore.myshopify.com'`);
  assert.equal(store.own_secret, true, "webhooks are verified with the store app's secret");
  const opened = await rawGet(`/shopify/install?${ownSigned({ shop: "cstore.myshopify.com", timestamp: "1700000012" })}`);
  assert.equal(opened.status, 302, "opening the store's own app from Shopify admin works");
});
