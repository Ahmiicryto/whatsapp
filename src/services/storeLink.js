import { one } from "../db/pool.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";
import { enqueue } from "../queue/queue.js";
import { fetchShopInfo } from "../shopify/client.js";
import { invalidateStore } from "./stores.js";

/**
 * Links a Shopify store (OAuth token) to a portal account and starts setup
 * (webhooks, default templates, order import). Returns the store id.
 */
/** Store-specific Shopify app for this shop, as { id, clientId, clientSecret }, or null. */
export async function shopifyAppFor({ shop, id }) {
  const row = id ? await one(`SELECT * FROM shopify_apps WHERE id=$1`, [id]) : await one(`SELECT * FROM shopify_apps WHERE shop=$1`, [String(shop || "").toLowerCase()]);
  return row ? { id: row.id, accountId: row.account_id, clientId: row.client_id, clientSecret: decrypt(row.client_secret_enc) } : null;
}

export async function linkShopifyStore({ accountId, shop, accessToken, scope, app = null }) {
  const domain = String(shop).toLowerCase();
  const existing = await one(`SELECT id, account_id FROM stores WHERE lower(shopify_domain)=$1`, [domain]);
  if (existing && existing.account_id !== accountId) {
    throw new HttpError(409, "This store is already connected to another account.");
  }
  const info = await fetchShopInfo({ id: 0, shopifyDomain: domain, shopifyToken: accessToken });
  const row = await one(
    `INSERT INTO stores (account_id, name, shopify_domain, shopify_token_enc, shopify_scopes, connection_type, currency, timezone, country, webhook_secret_enc)
     VALUES ($1,$2,$3,$4,$5,'oauth',$6,$7,$8,$9)
     ON CONFLICT (shopify_domain) DO UPDATE SET shopify_token_enc=EXCLUDED.shopify_token_enc, shopify_scopes=EXCLUDED.shopify_scopes,
       connection_type='oauth', webhook_secret_enc=$9, status='active', updated_at=now()
     RETURNING id`,
    [accountId, info.name, domain, encrypt(accessToken), scope, info.currency, info.timezone, info.country, app ? encrypt(app.clientSecret) : null]
  );
  invalidateStore(row.id);
  await enqueue("store.setup", { storeId: row.id }, { singletonKey: `store:${row.id}:setup` });
  return row.id;
}
