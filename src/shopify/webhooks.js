import { config } from "../config.js";
import { hmacBase64, safeEqual } from "../lib/crypto.js";
import { shopifyGraphql } from "./client.js";
import { logger } from "../logger.js";

export const WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "FULFILLMENTS_CREATE",
  "FULFILLMENTS_UPDATE",
  "CHECKOUTS_CREATE",
  "CHECKOUTS_UPDATE",
  "CUSTOMERS_CREATE",
  "CUSTOMERS_UPDATE",
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "PRODUCTS_DELETE",
  "APP_UNINSTALLED",
];

export function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader || !rawBody) return false;
  return safeEqual(hmacBase64(secret, rawBody), String(hmacHeader));
}

const CREATE_WITH_URI = `
mutation create($topic: WebhookSubscriptionTopic!, $uri: String!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;
const CREATE_WITH_CALLBACK = `
mutation create($topic: WebhookSubscriptionTopic!, $uri: URL!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $uri, format: JSON }) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

/**
 * Registers every topic for the store (idempotent: "already taken" errors are ignored).
 * Newer API versions use `uri`, older ones `callbackUrl`; we try `uri` first.
 */
export async function registerWebhooks(store) {
  const uri = `${config.baseUrl}/webhooks/shopify`;
  const existing = await shopifyGraphql(
    store,
    `{ webhookSubscriptions(first: 100) { nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`
  ).catch(() => null);
  const have = new Set(
    (existing?.webhookSubscriptions?.nodes || [])
      .filter((n) => n.endpoint?.callbackUrl === uri)
      .map((n) => n.topic)
  );

  const results = [];
  let mutation = CREATE_WITH_URI;
  for (const topic of WEBHOOK_TOPICS) {
    if (have.has(topic)) {
      results.push({ topic, ok: true, existing: true });
      continue;
    }
    try {
      let data;
      try {
        data = await shopifyGraphql(store, mutation, { topic, uri });
      } catch (err) {
        if (mutation === CREATE_WITH_URI && /uri|callbackUrl|argument/i.test(err.message)) {
          mutation = CREATE_WITH_CALLBACK;
          data = await shopifyGraphql(store, mutation, { topic, uri });
        } else throw err;
      }
      const errs = data.webhookSubscriptionCreate.userErrors;
      const ok = !errs.length || errs.every((e) => /taken|already/i.test(e.message));
      results.push({ topic, ok, error: ok ? undefined : errs.map((e) => e.message).join("; ") });
    } catch (err) {
      // e.g. CHECKOUTS_* need read_checkouts scope; keep going with the rest
      logger.warn({ store: store.id, topic, err: err.message }, "webhook registration failed");
      results.push({ topic, ok: false, error: err.message });
    }
  }
  return results;
}
