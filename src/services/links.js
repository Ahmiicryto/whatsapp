import { one, query } from "../db/pool.js";
import { randomToken } from "../lib/crypto.js";
import { config } from "../config.js";

/** Creates a tracked short link; returns the code used in `${APP_BASE_URL}/r/<code>`. */
export async function createShortLink({ storeId, targetUrl, kind, campaignId, recipientId, orderId }) {
  for (let i = 0; i < 5; i++) {
    const code = randomToken(6).replace(/[-_]/g, "x").slice(0, 8);
    const { rowCount } = await query(
      `INSERT INTO short_links (code, store_id, target_url, kind, campaign_id, recipient_id, order_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [code, storeId, targetUrl, kind ?? null, campaignId ?? null, recipientId ?? null, orderId ?? null]
    );
    if (rowCount) return code;
  }
  throw new Error("could not allocate short link");
}

export const shortUrl = (code) => `${config.baseUrl}/r/${code}`;

/** Resolves a click: counts it, marks the campaign recipient as clicked, returns the target. */
export async function resolveShortLink(code) {
  const link = await one(
    `UPDATE short_links SET clicks = clicks + 1 WHERE code=$1 RETURNING target_url, recipient_id`,
    [code]
  );
  if (!link) return null;
  if (link.recipient_id) {
    await query(`UPDATE campaign_recipients SET clicked_at = COALESCE(clicked_at, now()) WHERE id=$1`, [link.recipient_id]);
  }
  return link.target_url;
}

/** Adds UTM params so Shopify analytics can attribute the visit as well. */
export function withUtm(url, { campaign, content } = {}) {
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", "whatsapp");
    u.searchParams.set("utm_medium", "message");
    if (campaign) u.searchParams.set("utm_campaign", campaign);
    if (content) u.searchParams.set("utm_content", content);
    return u.toString();
  } catch {
    return url;
  }
}
