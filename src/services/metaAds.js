/**
 * Meta (Facebook/Instagram) ad spend via the Marketing API: daily account insights are upserted
 * into ad_spend so the Profit and Finance pages always have real ad costs.
 * Needs an access token with ads_read (a System User token from Business Settings is best).
 */
import { one, many, query } from "../db/pool.js";
import { config } from "../config.js";
import { requestJson } from "../lib/http.js";
import { decrypt } from "../lib/crypto.js";
import { logger } from "../logger.js";

const graph = () => `https://graph.facebook.com/${config.meta.graphVersion}`;
export const normalizeAccountId = (id) => String(id || "").trim().replace(/^act_/, "").replace(/\D/g, "");

async function call(path, token, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = await requestJson(`${graph()}/${path}?${qs}`, { timeoutMs: 30000 });
  if (!res.ok) {
    const e = res.json?.error || {};
    const err = new Error(e.message || `Meta API error (HTTP ${res.status})`);
    err.code = e.code;
    throw err;
  }
  return res.json;
}

/** Validates the token + account and returns { name, currency, status }. */
export async function fetchAccount(accountId, token) {
  const a = await call(`act_${normalizeAccountId(accountId)}`, token, { fields: "name,currency,account_status" });
  return { name: a.name, currency: a.currency, status: a.account_status };
}

const day = (d) => d.toISOString().slice(0, 10);

/** Daily spend, impressions, clicks, purchases and purchase value for a date range (inclusive). */
export async function fetchDailyInsights(accountId, token, since, until) {
  const out = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const params = {
      level: "account",
      time_increment: "1",
      fields: "spend,impressions,clicks,actions,action_values",
      time_range: JSON.stringify({ since: day(since), until: day(until) }),
      limit: "100",
    };
    if (after) params.after = after;
    const r = await call(`act_${normalizeAccountId(accountId)}/insights`, token, params);
    for (const row of r.data || []) {
      const purchase = (list) => Number((list || []).find((a) => ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"].includes(a.action_type))?.value || 0);
      out.push({
        day: row.date_start,
        spend: Number(row.spend || 0),
        impressions: Number(row.impressions || 0),
        clicks: Number(row.clicks || 0),
        purchases: Math.round(purchase(row.actions)),
        purchaseValue: purchase(row.action_values),
      });
    }
    after = r.paging?.next ? r.paging?.cursors?.after : null;
    if (!after) break;
  }
  return out;
}

/** Pull the last `days` days for one connected ad account. */
export async function syncAdAccount(accountRowId, { days = 3 } = {}) {
  const acc = await one(`SELECT * FROM ad_accounts WHERE id=$1`, [accountRowId]);
  if (!acc) return 0;
  const until = new Date();
  const since = new Date(Date.now() - (days - 1) * 86400000);
  try {
    const rows = await fetchDailyInsights(acc.account_id, decrypt(acc.token_enc), since, until);
    const fx = Number(acc.fx_rate || 1);
    const channel = `meta:${acc.account_id}`; // one row per day per ad account
    for (const r of rows) {
      await query(
        `INSERT INTO ad_spend (store_id, day, channel, amount, impressions, clicks, purchases, purchase_value, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'meta_api')
         ON CONFLICT (store_id, day, channel) DO UPDATE SET amount=EXCLUDED.amount, impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
           purchases=EXCLUDED.purchases, purchase_value=EXCLUDED.purchase_value, source='meta_api'`,
        [acc.store_id, r.day, channel, Math.round(r.spend * fx * 100) / 100, r.impressions, r.clicks, r.purchases, Math.round(r.purchaseValue * fx * 100) / 100]
      );
    }
    // Synced numbers replace hand-typed "meta" spend for the same days (no double counting).
    if (rows.length) {
      await query(`DELETE FROM ad_spend WHERE store_id=$1 AND channel='meta' AND source <> 'meta_api' AND day BETWEEN $2 AND $3`, [acc.store_id, rows[0].day, rows[rows.length - 1].day]);
    }
    await query(`UPDATE ad_accounts SET last_synced_at=now(), last_error=NULL WHERE id=$1`, [acc.id]);
    return rows.length;
  } catch (err) {
    await query(`UPDATE ad_accounts SET last_error=$2 WHERE id=$1`, [acc.id, String(err.message).slice(0, 500)]);
    logger.warn({ account: acc.id, err: err.message }, "meta ads sync failed");
    throw err;
  }
}

export async function adAccountsToSync() {
  return many(`SELECT a.id, a.store_id FROM ad_accounts a JOIN stores s ON s.id=a.store_id WHERE s.status='active'`);
}
