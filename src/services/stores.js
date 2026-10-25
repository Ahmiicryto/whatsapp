import { one, many } from "../db/pool.js";
import { decrypt } from "../lib/crypto.js";
import { config } from "../config.js";
import { resolveSettings } from "./settings.js";

const cache = new Map();
const TTL = 30_000;

export function invalidateStore(storeId) {
  cache.delete(Number(storeId));
}

/**
 * Store with decrypted credentials and merged settings. Used by every job and webhook.
 * ctx.wa is null when no WhatsApp number is linked.
 */
export async function getStoreContext(storeId) {
  const id = Number(storeId);
  const hit = cache.get(id);
  if (hit && hit.at > Date.now() - TTL) return hit.ctx;

  const row = await one(
    `SELECT s.*, a.status AS account_status, a.limits AS account_limits,
            w.id AS wa_id, w.phone_number_id, w.waba_id, w.token_enc AS wa_token_enc,
            w.app_secret_enc AS wa_app_secret_enc, w.display_number, w.quality_rating
       FROM stores s
       JOIN accounts a ON a.id = s.account_id
       LEFT JOIN whatsapp_numbers w ON w.id = s.whatsapp_number_id
      WHERE s.id = $1`,
    [id]
  );
  if (!row) return null;
  const keys = await many(`SELECT provider, key_enc FROM api_keys WHERE store_id=$1`, [id]);
  const apiKeys = Object.fromEntries(keys.map((k) => [k.provider, decrypt(k.key_enc)]));
  const settings = resolveSettings(row.settings);

  const ctx = {
    id: row.id,
    accountId: row.account_id,
    name: settings.displayName || row.name,
    shopifyDomain: row.shopify_domain,
    shopifyToken: decrypt(row.shopify_token_enc),
    webhookSecret: row.webhook_secret_enc ? decrypt(row.webhook_secret_enc) : config.shopify.apiSecret,
    connectionType: row.connection_type,
    currency: row.currency,
    timezone: row.timezone || config.defaults.timezone,
    country: row.country || config.defaults.country,
    logoUrl: row.logo_url,
    status: row.status,
    accountStatus: row.account_status,
    active: row.status === "active" && row.account_status === "active",
    settings,
    apiKeys: {
      openai: apiKeys.openai || config.openai.apiKey,
      gemini: apiKeys.gemini || config.gemini.apiKey,
      google: apiKeys.google || config.google.mapsKey,
    },
    wa: row.wa_id
      ? {
          id: row.wa_id,
          phoneNumberId: row.phone_number_id,
          wabaId: row.waba_id,
          token: decrypt(row.wa_token_enc),
          appSecret: row.wa_app_secret_enc ? decrypt(row.wa_app_secret_enc) : config.meta.appSecret,
          displayNumber: row.display_number,
          qualityRating: row.quality_rating,
        }
      : null,
  };
  cache.set(id, { at: Date.now(), ctx });
  return ctx;
}

export async function findStoreByDomain(domain) {
  return one(`SELECT id FROM stores WHERE lower(shopify_domain)=lower($1)`, [domain]);
}
