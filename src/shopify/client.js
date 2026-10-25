import { config } from "../config.js";
import { requestJson, sleep, ApiError } from "../lib/http.js";
import { logger } from "../logger.js";

export class ShopifyError extends ApiError {}

/** Admin GraphQL call with backoff on 429 / THROTTLED / 5xx. */
export async function shopifyGraphql(store, gql, variables = {}) {
  if (!store.shopifyToken) throw new ShopifyError(`Store ${store.id} has no Shopify access token`);
  const url = `https://${store.shopifyDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await requestJson(url, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": store.shopifyToken },
      body: { query: gql, variables },
    });
    const throttled =
      res.status === 429 || (res.json?.errors || []).some?.((e) => e?.extensions?.code === "THROTTLED");
    if (throttled || res.status >= 500) {
      const wait = 1000 * attempt * attempt;
      logger.warn({ store: store.id, status: res.status, wait }, "shopify throttled, retrying");
      await sleep(wait);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new ShopifyError(`Shopify rejected the access token (${res.status})`, { status: res.status, body: res.json });
    }
    if (!res.ok || res.json.errors) {
      const msg = Array.isArray(res.json.errors)
        ? res.json.errors.map((e) => e.message).join("; ")
        : JSON.stringify(res.json.errors || res.json);
      throw new ShopifyError(`Shopify GraphQL error: ${msg}`, { status: res.status, body: res.json });
    }
    return res.json.data;
  }
  throw new ShopifyError("Shopify API kept throttling, giving up");
}

/** Throws if a mutation payload has userErrors. */
export function assertNoUserErrors(payload, label) {
  const errors = payload?.userErrors || payload?.orderCancelUserErrors || [];
  if (errors.length) throw new ShopifyError(`${label}: ${errors.map((e) => e.message).join("; ")}`);
  return payload;
}

export const gid = (type, id) => (String(id).startsWith("gid://") ? String(id) : `gid://shopify/${type}/${id}`);
export const legacyId = (g) => (g ? Number(String(g).split("/").pop()) : null);

/** Lightweight shop info used when connecting a store. */
export async function fetchShopInfo(store) {
  const data = await shopifyGraphql(
    store,
    `{ shop { name currencyCode ianaTimezone myshopifyDomain billingAddress { countryCodeV2 } } }`
  );
  return {
    name: data.shop.name,
    currency: data.shop.currencyCode,
    timezone: data.shop.ianaTimezone,
    domain: data.shop.myshopifyDomain,
    country: data.shop.billingAddress?.countryCodeV2 || null,
  };
}
