import crypto from "node:crypto";
import { pool } from "../src/db/pool.js";
import { bootstrap } from "../src/bootstrap.js";
import { createApp } from "../src/app.js";
import { Worker } from "../src/queue/queue.js";
import { handlers } from "../src/jobs/index.js";

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------- outbound HTTP mock
export const calls = [];
const routes = [];
let waCounter = 0;

export function mock(match, respond) {
  routes.unshift({ match, respond });
}

export function resetMocks() {
  calls.length = 0;
  routes.length = 0;
  installDefaultMocks();
}

export const callsTo = (pattern) => calls.filter((c) => (typeof pattern === "string" ? c.url.includes(pattern) : pattern.test(c.url)));
export const waSends = () => calls.filter((c) => c.method === "POST" && /graph\.facebook\.com\/.+\/\d+\/messages$/.test(c.url) && c.body?.type);
export const shopifyCalls = (needle) => calls.filter((c) => c.url.includes("/graphql.json") && c.body?.query?.includes(needle));

function installDefaultMocks() {
  const gql = (needle, data) => mock((u, b) => u.includes("/graphql.json") && b?.query?.includes(needle), () => ({ data }));
  gql("shop {", { shop: { name: "Glow Candles", currencyCode: "PKR", ianaTimezone: "Asia/Karachi", myshopifyDomain: "glow.myshopify.com", billingAddress: { countryCodeV2: "PK" } } });
  gql("webhookSubscriptions(", { webhookSubscriptions: { nodes: [] } });
  gql("webhookSubscriptionCreate", { webhookSubscriptionCreate: { webhookSubscription: { id: "gid://x" }, userErrors: [] } });
  gql("tagsAdd", { tagsAdd: { userErrors: [] } });
  gql("tagsRemove", { tagsRemove: { userErrors: [] } });
  gql("orderUpdate", { orderUpdate: { order: { id: "gid://shopify/Order/1" }, userErrors: [] } });
  gql("orderCancel", { orderCancel: { job: { id: "j" }, orderCancelUserErrors: [] } });
  gql("discountCodeBasicCreate", { discountCodeBasicCreate: { codeDiscountNode: { id: "d" }, userErrors: [] } });
  gql("orders(first", { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } });
  gql("nodes(ids", {
    nodes: [{ id: "gid://shopify/ProductVariant/501", legacyResourceId: "501", image: { url: "https://cdn.shopify.com/candle.jpg" }, product: { legacyResourceId: "401", featuredMedia: null } }],
  });

  mock((u, b, m) => m === "POST" && /graph\.facebook\.com\/v[\d.]+\/\d+\/messages$/.test(u) && b?.status !== "read", () => ({ messages: [{ id: `wamid.${++waCounter}` }] }));
  mock((u, b, m) => m === "POST" && /\/messages$/.test(u) && b?.status === "read", () => ({ success: true }));
  mock((u, _b, m) => m === "GET" && /graph\.facebook\.com\/v[\d.]+\/\d+\?fields=display_phone_number/.test(u), () => ({ display_phone_number: "+92 300 0000000", verified_name: "Glow Candles", quality_rating: "GREEN", messaging_limit_tier: "TIER_1K" }));
  mock((u) => u.includes("/subscribed_apps"), () => ({ success: true }));
  mock((u, _b, m) => m === "GET" && u.includes("/message_templates"), () => ({ data: [] }));
  mock((u, _b, m) => m === "POST" && u.includes("/message_templates"), () => ({ id: `tpl${++waCounter}`, status: "PENDING", category: "UTILITY" }));
  mock((u) => /\/uploads\?/.test(u), () => ({ id: "upload:abc" }));
  mock((u) => /graph\.facebook\.com\/v[\d.]+\/upload:abc$/.test(u), () => ({ h: "4::handle" }));
  mock((u, _b, m) => m === "POST" && /\/\d+\/media$/.test(u), () => ({ id: "media-123" }));
}

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("http://127.0.0.1")) return realFetch(url, init);
  const method = (init.method || "GET").toUpperCase();
  let body = init.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* keep string */
    }
  }
  calls.push({ url, method, body, headers: init.headers || {} });
  for (const r of routes) {
    if (r.match(url, body, method)) {
      const out = await r.respond(url, body, method);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out.__json ?? out), { status: out.__status || 200, headers: { "content-type": "application/json" } });
    }
  }
  return new Response(JSON.stringify({ error: { message: `unmocked ${method} ${url}` } }), { status: 500, headers: { "content-type": "application/json" } });
};

// ---------------------------------------------------------------- app + db
let server;
let baseUrl;
export const worker = new Worker(handlers, { concurrency: 4 });

export async function setup() {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await bootstrap();
  resetMocks();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

export async function teardown() {
  await new Promise((r) => server.close(r));
  await pool.end();
}

/** Tiny cookie-keeping API client. */
export function client() {
  let cookie = "";
  async function call(method, path, body, extraHeaders = {}) {
    const res = await realFetch(baseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "wa-portal",
        ...(cookie ? { Cookie: cookie } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
  return {
    get: (p) => call("GET", p),
    post: (p, b, h) => call("POST", p, b ?? {}, h),
    put: (p, b) => call("PUT", p, b),
    patch: (p, b) => call("PATCH", p, b),
    del: (p) => call("DELETE", p),
    raw: call,
    form: (p, fields) => call("POST", p, new URLSearchParams(fields).toString(), { "Content-Type": "application/x-www-form-urlencoded" }),
    cookie: () => cookie,
  };
}

export async function rawPost(path, rawBody, headers) {
  const res = await realFetch(baseUrl + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: rawBody });
  return { status: res.status, text: await res.text() };
}

export async function rawGet(path, headers = {}) {
  const res = await realFetch(baseUrl + path, { redirect: "manual", headers });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

export const shopifyHmac = (secret, raw) => crypto.createHmac("sha256", secret).update(raw).digest("base64");
export const metaSig = (secret, raw) => `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;

export async function sendShopifyWebhook(topic, payload, { domain = "glow.myshopify.com", secret = "shpss_store_secret", id } = {}) {
  const raw = JSON.stringify(payload);
  return rawPost("/webhooks/shopify", raw, {
    "X-Shopify-Topic": topic,
    "X-Shopify-Shop-Domain": domain,
    "X-Shopify-Hmac-Sha256": shopifyHmac(secret, raw),
    "X-Shopify-Webhook-Id": id || crypto.randomUUID(),
  });
}

export async function sendWaWebhook(value, field = "messages") {
  const body = { object: "whatsapp_business_account", entry: [{ id: "WABA1", changes: [{ field, value }] }] };
  const raw = JSON.stringify(body);
  return rawPost("/webhooks/whatsapp", raw, { "X-Hub-Signature-256": metaSig("meta-app-secret", raw) });
}

export function inboundMessage(from, message, phoneNumberId = "109876543210987") {
  return {
    messaging_product: "whatsapp",
    metadata: { phone_number_id: phoneNumberId, display_phone_number: "923000000000" },
    contacts: [{ wa_id: from, profile: { name: "Ayesha" } }],
    messages: [{ from, id: `wamid.in.${crypto.randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
  };
}

export async function q(sql, params) {
  return (await pool.query(sql, params)).rows;
}
