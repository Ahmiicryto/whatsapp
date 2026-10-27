import crypto from "node:crypto";
import { config } from "../config.js";
import { requestJson } from "../lib/http.js";
import { safeEqual } from "../lib/crypto.js";

export function isValidShopDomain(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(String(shop || ""));
}

export function normalizeShopDomain(input) {
  let shop = String(input || "").trim().toLowerCase();
  shop = shop.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (shop && !shop.includes(".")) shop = `${shop}.myshopify.com`;
  return shop;
}

/** The platform app (env keys) unless a store-specific app { clientId, clientSecret } is given. */
const keysOf = (app) => ({ clientId: app?.clientId || config.shopify.apiKey, clientSecret: app?.clientSecret || config.shopify.apiSecret });

export function buildInstallUrl(shop, state, app = null) {
  const params = new URLSearchParams({
    client_id: keysOf(app).clientId,
    scope: config.shopify.scopes,
    redirect_uri: `${config.baseUrl}/shopify/callback`,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params}`;
}

/** Verifies the `hmac` query param Shopify adds to the OAuth callback. */
export function verifyOAuthQuery(query, app = null) {
  const { hmac, signature, ...rest } = query;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`)
    .join("&");
  const digest = crypto.createHmac("sha256", keysOf(app).clientSecret || "").update(message).digest("hex");
  return safeEqual(digest, String(hmac || ""));
}

export async function exchangeCodeForToken(shop, code, app = null) {
  const k = keysOf(app);
  const res = await requestJson(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    body: { client_id: k.clientId, client_secret: k.clientSecret, code },
  });
  if (!res.ok || !res.json.access_token) {
    throw new Error(`Shopify token exchange failed (${res.status})`);
  }
  return { accessToken: res.json.access_token, scope: res.json.scope };
}
