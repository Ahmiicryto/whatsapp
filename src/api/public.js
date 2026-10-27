import express, { Router } from "express";
import { one, many, query } from "../db/pool.js";
import { ah } from "../lib/errors.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { decrypt, encrypt, verifySignature, safeEqual, randomToken } from "../lib/crypto.js";
import { linkShopifyStore, shopifyAppFor } from "../services/storeLink.js";
import { enqueue } from "../queue/queue.js";
import { verifyShopifyHmac } from "../shopify/webhooks.js";
import { verifyOAuthQuery, exchangeCodeForToken, isValidShopDomain, normalizeShopDomain, buildInstallUrl } from "../shopify/oauth.js";
import { verifyMetaSignature } from "../whatsapp/webhookParser.js";
import { verifyGatewaySignature } from "../whatsapp/gateway.js";
import { resolveShortLink } from "../services/links.js";
import { fetchStaticMap } from "../google/address.js";
import { invalidateStore } from "../services/stores.js";
import { normalizePhone } from "../lib/phone.js";
import { verifyStripeSignature } from "../services/stripe.js";
import { handleStripeEvent } from "../services/stripeEvents.js";
import { getStoreContext } from "../services/stores.js";
import { subscribeStock } from "../services/stock.js";

const r = Router();

// ---------------------------------------------------------------- Shopify webhooks

r.post(
  "/webhooks/shopify",
  ah(async (req, res) => {
    const domain = String(req.get("X-Shopify-Shop-Domain") || "").toLowerCase();
    const topic = req.get("X-Shopify-Topic");
    const webhookId = req.get("X-Shopify-Webhook-Id") || req.get("X-Shopify-Event-Id");
    const store = await one(`SELECT id, webhook_secret_enc FROM stores WHERE lower(shopify_domain)=$1`, [domain]);
    if (!store) {
      logger.warn({ domain, topic }, "webhook for unknown shop");
      return res.status(200).send("unknown shop");
    }
    const secret = store.webhook_secret_enc ? decrypt(store.webhook_secret_enc) : config.shopify.apiSecret;
    if (!verifyShopifyHmac(req.rawBody, req.get("X-Shopify-Hmac-Sha256"), secret)) {
      logger.warn({ domain, topic }, "shopify webhook HMAC failed");
      return res.status(401).send("invalid hmac");
    }
    if (webhookId) {
      const { rowCount } = await query(`INSERT INTO webhook_events (id, source, store_id, topic) VALUES ($1,'shopify',$2,$3) ON CONFLICT DO NOTHING`, [webhookId, store.id, topic]);
      if (!rowCount) return res.status(200).send("duplicate");
    }
    await enqueue("shopify.webhook", { storeId: store.id, topic, payload: req.body });
    res.status(200).send("ok");
  })
);

/** Mandatory privacy webhooks for apps distributed through Shopify. */
r.post(
  "/webhooks/shopify/compliance",
  ah(async (req, res) => {
    if (!verifyShopifyHmac(req.rawBody, req.get("X-Shopify-Hmac-Sha256"), config.shopify.apiSecret)) return res.status(401).send("invalid hmac");
    const topic = req.get("X-Shopify-Topic");
    const domain = String(req.body.shop_domain || "").toLowerCase();
    const store = await one(`SELECT id FROM stores WHERE lower(shopify_domain)=$1`, [domain]);
    logger.info({ topic, domain }, "compliance webhook");
    if (store && topic === "customers/redact") {
      const c = req.body.customer || {};
      const phone = normalizePhone(c.phone, null);
      const customer = await one(`SELECT id, phone_e164 FROM customers WHERE store_id=$1 AND (shopify_customer_id=$2 OR (phone_e164 IS NOT NULL AND phone_e164=$3)) LIMIT 1`, [store.id, c.id || 0, phone]);
      const orderIds = (req.body.orders_to_redact || []).map(Number);
      await query(
        `UPDATE orders SET customer_name=NULL, first_name=NULL, phone_e164=NULL, phone_raw=NULL, email=NULL, shipping_address=NULL, address_text=NULL
          WHERE store_id=$1 AND (shopify_order_id = ANY($2) OR customer_id=$3)`,
        [store.id, orderIds, customer?.id || 0]
      );
      if (customer?.phone_e164) {
        await query(`DELETE FROM messages WHERE store_id=$1 AND conversation_id IN (SELECT id FROM conversations WHERE store_id=$1 AND phone_e164=$2)`, [store.id, customer.phone_e164]);
        await query(`DELETE FROM conversations WHERE store_id=$1 AND phone_e164=$2`, [store.id, customer.phone_e164]);
      }
      if (customer) await query(`DELETE FROM customers WHERE id=$1`, [customer.id]);
    }
    if (store && topic === "shop/redact") {
      await query(`DELETE FROM stores WHERE id=$1`, [store.id]);
      invalidateStore(store.id);
    }
    res.status(200).send("ok");
  })
);

// ---------------------------------------------------------------- WhatsApp webhooks

function verifyChallenge(req, res, expected) {
  if (req.query["hub.mode"] === "subscribe" && expected && safeEqual(String(req.query["hub.verify_token"] || ""), expected)) {
    return res.status(200).send(String(req.query["hub.challenge"] || ""));
  }
  return res.status(403).send("forbidden");
}

r.get("/webhooks/whatsapp", (req, res) => verifyChallenge(req, res, config.meta.verifyToken));

r.get(
  "/webhooks/whatsapp/:key",
  ah(async (req, res) => {
    const n = await one(`SELECT webhook_key FROM whatsapp_numbers WHERE webhook_key=$1`, [req.params.key]);
    return verifyChallenge(req, res, n?.webhook_key);
  })
);

async function acceptWa(req, res, secret) {
  if (!verifyMetaSignature(req.rawBody, req.get("X-Hub-Signature-256"), secret)) {
    logger.warn("whatsapp webhook signature failed");
    return res.status(401).send("invalid signature");
  }
  await enqueue("wa.webhook", { body: req.body }, { maxAttempts: 3 });
  res.status(200).send("ok");
}

r.post("/webhooks/whatsapp", ah((req, res) => acceptWa(req, res, config.meta.appSecret)));

r.post(
  "/webhooks/whatsapp/:key",
  ah(async (req, res) => {
    const n = await one(`SELECT app_secret_enc FROM whatsapp_numbers WHERE webhook_key=$1`, [req.params.key]);
    if (!n) return res.status(404).send("unknown");
    return acceptWa(req, res, n.app_secret_enc ? decrypt(n.app_secret_enc) : config.meta.appSecret);
  })
);

// ---------------------------------------------------------------- QR gateway (WhatsApp Web) events

r.post(
  "/webhooks/gateway",
  ah(async (req, res) => {
    if (!verifyGatewaySignature(req.rawBody, req.get("X-Gateway-Signature"))) return res.status(401).send("invalid signature");
    for (const ev of req.body?.events || []) await enqueue("gateway.event", { ev }, { maxAttempts: 3 });
    res.status(200).send("ok");
  })
);

// ---------------------------------------------------------------- Stripe (plans + card advance payments)

r.post(
  "/webhooks/stripe",
  ah(async (req, res) => {
    if (!verifyStripeSignature(req.rawBody?.toString("utf8") || "", req.get("Stripe-Signature"))) return res.status(400).send("invalid signature");
    const event = req.body;
    const fresh = await one(`INSERT INTO webhook_events (id, source, topic) VALUES ($1,'stripe',$2) ON CONFLICT DO NOTHING RETURNING id`, [`stripe:${event.id}`, event.type]);
    if (fresh) await handleStripeEvent(event);
    res.json({ received: true });
  })
);

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function simplePage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f8fb;color:#0f172a;padding:16px}
@media (prefers-color-scheme:dark){body{background:#0a1120;color:#e2e8f0}.c{background:#0f172a!important}}
.c{background:#fff;max-width:380px;width:100%;border-radius:20px;padding:24px;box-shadow:0 12px 32px -8px rgb(15 23 42/.15)}img{width:100%;border-radius:14px;aspect-ratio:1;object-fit:cover}
h1{font-size:20px;margin:14px 0 6px}p{color:#64748b;font-size:14px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #cbd5e1;border-radius:12px;font-size:16px;margin:8px 0}
button{width:100%;padding:12px;border:0;border-radius:12px;background:#059669;color:#fff;font-weight:700;font-size:15px;cursor:pointer}</style></head><body><div class="c">${body}</div></body></html>`;
}

r.get("/paid", (req, res) => res.send(simplePage("Payment", req.query.cancelled ? "<h1>Payment cancelled</h1><p>You can close this page and try again from WhatsApp.</p>" : "<h1>Thank you! ✅</h1><p>Your payment was received. You can close this page and go back to WhatsApp.</p>")));

// "Notify me when it's back" page: share /notify/STORE_ID/PRODUCT_ID on out-of-stock product pages.
r.get(
  "/notify/:storeId/:productId",
  ah(async (req, res) => {
    const p = await one(`SELECT p.title, p.image_url, s.name AS store FROM products p JOIN stores s ON s.id=p.store_id WHERE p.store_id=$1 AND p.shopify_product_id=$2`, [Number(req.params.storeId), Number(req.params.productId)]);
    if (!p) return res.status(404).send(simplePage("Not found", "<h1>Product not found</h1>"));
    const variant = req.query.variant ? `<input type="hidden" name="variant" value="${esc(Number(req.query.variant) || "")}">` : "";
    res.send(
      simplePage(
        `${p.title} · ${p.store}`,
        `${p.image_url ? `<img src="${esc(p.image_url)}" alt="">` : ""}<h1>${esc(p.title)}</h1><p>Sold out right now. Leave your WhatsApp number and ${esc(p.store)} will message you the moment it's back.</p>
<form method="post">${variant}<input name="phone" type="tel" required placeholder="WhatsApp number, e.g. 0300 1234567" autocomplete="tel"><button>Notify me on WhatsApp</button></form>`
      )
    );
  })
);

r.post(
  "/notify/:storeId/:productId",
  express.urlencoded({ extended: false, limit: "4kb" }),
  ah(async (req, res) => {
    const store = await getStoreContext(Number(req.params.storeId));
    if (!store) return res.status(404).send(simplePage("Not found", "<h1>Store not found</h1>"));
    try {
      await subscribeStock(store, { productId: Number(req.params.productId), variantId: Number(req.body.variant) || null, phone: String(req.body.phone || "") });
      res.send(simplePage("Done", `<h1>You're on the list ✅</h1><p>We'll message you on WhatsApp as soon as it's back in stock.</p>`));
    } catch (err) {
      res.status(400).send(simplePage("Try again", `<h1>Please check the number</h1><p>${esc(err.message)}</p><p><a href="">Go back</a></p>`));
    }
  })
);

// Published reviews as JSON for the store's website (CORS open, read-only).
r.get(
  "/public/stores/:storeId/reviews.json",
  ah(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300");
    const rows = await many(
      `SELECT r.id, r.rating, r.body, r.media, r.customer_name, r.created_at, r.shopify_product_id, p.title AS product
         FROM reviews r LEFT JOIN products p ON p.store_id=r.store_id AND p.shopify_product_id=r.shopify_product_id
        WHERE r.store_id=$1 AND r.status='published' ${req.query.product ? "AND r.shopify_product_id=$2" : ""} ORDER BY r.created_at DESC LIMIT 100`,
      req.query.product ? [Number(req.params.storeId), Number(req.query.product)] : [Number(req.params.storeId)]
    );
    const avg = rows.length ? Math.round((rows.reduce((s, x) => s + Number(x.rating || 0), 0) / rows.length) * 10) / 10 : null;
    res.json({
      average: avg,
      count: rows.length,
      reviews: rows.map((x) => ({ ...x, customer_name: x.customer_name ? `${String(x.customer_name).split(" ")[0]} ${String(x.customer_name).split(" ")[1]?.[0] || ""}.`.trim() : "Customer" })),
    });
  })
);

// ---------------------------------------------------------------- Shopify app install (OAuth)

/** Account the signed-in user can link stores to (admin or owner), or null. */
function linkableAccount(req) {
  if (!req.user || !req.accountId) return null;
  if (req.user.isSuperAdmin) return req.accountId;
  return ["owner", "admin"].includes(req.membership?.role) ? req.accountId : null;
}

/** Page shown inside the Shopify admin iframe: OAuth must run in the top window. */
function breakOutOfIframe(res, url) {
  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy", "frame-ancestors https://admin.shopify.com https://*.myshopify.com; script-src 'unsafe-inline'");
  const safe = url.replace(/"/g, "&quot;");
  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>WA Commerce</title>
<body style="font-family:system-ui;padding:32px;text-align:center">
<p>Opening WA Commerce…</p><p><a href="${safe}" target="_top" style="color:#16a34a;font-weight:600">Continue</a></p>
<script>try{window.top.location.href=${JSON.stringify(url)}}catch(e){}</script></body>`);
}

/**
 * App URL for the Shopify app. Shopify sends merchants here after they click the install link,
 * or when they open the app from Shopify admin. Also used by the portal's /install page.
 */
r.get(
  "/shopify/install",
  ah(async (req, res) => {
    const shop = normalizeShopDomain(req.query.shop);
    if (!isValidShopDomain(shop)) return res.status(400).send("Missing or invalid shop. Use yourstore.myshopify.com");
    // A store with its own Shopify app (added under Stores → Connect store → Own Shopify app) uses those keys.
    const app = await shopifyAppFor({ shop });
    if (!app && (!config.shopify.apiKey || !config.shopify.apiSecret)) {
      return res.status(500).send("Shopify app keys are not configured (SHOPIFY_API_KEY / SHOPIFY_API_SECRET).");
    }
    const fromShopify = !!req.query.hmac;
    if (fromShopify && !verifyOAuthQuery(req.query, app) && !(app && verifyOAuthQuery(req.query))) return res.status(400).send("Invalid Shopify signature");

    // Opened from Shopify admin for a store that is already linked: go straight to the portal.
    const existing = await one(`SELECT id FROM stores WHERE lower(shopify_domain)=$1 AND shopify_token_enc IS NOT NULL AND status='active'`, [shop]);
    if (fromShopify && existing) {
      const target = `${config.baseUrl}/stores/${existing.id}`;
      return req.query.embedded === "1" ? breakOutOfIframe(res, target) : res.redirect(target);
    }

    const state = randomToken(24);
    await query(`INSERT INTO oauth_states (state, user_id, account_id, shop, app_id) VALUES ($1,$2,$3,$4,$5)`, [state, req.user?.id ?? null, linkableAccount(req) || app?.accountId || null, shop, app?.id ?? null]);
    const url = buildInstallUrl(shop, state, app);
    return req.query.embedded === "1" ? breakOutOfIframe(res, url) : res.redirect(url);
  })
);

r.get(
  "/shopify/callback",
  ah(async (req, res) => {
    const { shop, code, state } = req.query;
    if (!isValidShopDomain(shop)) return res.status(400).send("Invalid Shopify callback");
    const pendingState = await one(`SELECT app_id FROM oauth_states WHERE state=$1`, [String(state || "")]);
    const app = pendingState?.app_id ? await shopifyAppFor({ id: pendingState.app_id }) : null;
    if (!verifyOAuthQuery(req.query, app)) return res.status(400).send("Invalid Shopify callback");
    const st = await one(`DELETE FROM oauth_states WHERE state=$1 AND created_at > now() - interval '1 hour' RETURNING *`, [state]);
    if (!st || st.shop !== String(shop).toLowerCase()) return res.status(400).send("Install link expired. Please install the app again.");
    const { accessToken, scope } = await exchangeCodeForToken(shop, code, app);

    // Link right away when we know the account (started from the portal, or the installer is signed in).
    // A store that was linked before (e.g. reinstall after uninstall) returns to its own account.
    const prior = await one(`SELECT account_id FROM stores WHERE lower(shopify_domain)=$1`, [String(shop).toLowerCase()]);
    const accountId = st.account_id || prior?.account_id || linkableAccount(req);
    if (accountId) {
      try {
        const storeId = await linkShopifyStore({ accountId, shop, accessToken, scope, app });
        return res.redirect(`/stores/${storeId}?connected=1`);
      } catch (err) {
        if (err.status === 409) return res.status(409).send(err.message);
        throw err;
      }
    }
    // Otherwise park the install until someone signs in (or signs up) and claims it.
    const token = randomToken(24);
    await query(`INSERT INTO pending_installs (token, shop, access_token_enc, scope, app_id) VALUES ($1,$2,$3,$4,$5)`, [token, String(shop).toLowerCase(), encrypt(accessToken), scope, app?.id ?? null]);
    res.redirect(`/claim-store?token=${encodeURIComponent(token)}`);
  })
);

// ---------------------------------------------------------------- links & media

r.get(
  "/r/:code",
  ah(async (req, res) => {
    const target = await resolveShortLink(req.params.code);
    if (!target) return res.status(404).send("Link not found");
    res.redirect(302, target);
  })
);

r.get(
  "/media/f/:token/:name?",
  ah(async (req, res) => {
    const f = await one(`SELECT mime, data FROM media_files WHERE token=$1`, [req.params.token]);
    if (!f) return res.status(404).send("not found");
    res.setHeader("Content-Type", f.mime);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(f.data);
  })
);

const mapCache = new Map();

r.get(
  "/media/map",
  ah(async (req, res) => {
    const v = String(req.query.v || "");
    if (!verifySignature(v, req.query.s) || !config.google.mapsKey) return res.status(404).send("not found");
    let img = mapCache.get(v);
    if (!img) {
      img = await fetchStaticMap(v, config.google.mapsKey);
      if (mapCache.size > 500) mapCache.clear();
      mapCache.set(v, img);
    }
    res.setHeader("Content-Type", img.mime);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(img.buffer);
  })
);

r.get(
  "/media/orders-map",
  ah(async (req, res) => {
    const v = String(req.query.v || "");
    if (!verifySignature(v, req.query.s) || !config.google.mapsKey) return res.status(404).send("not found");
    const markers = v.split(";").map((p) => p.split(":")).slice(0, 60);
    const img = await fetchStaticMap("0,0,5,640x360", config.google.mapsKey, markers);
    res.setHeader("Content-Type", img.mime);
    res.setHeader("Cache-Control", "private, max-age=600");
    res.send(img.buffer);
  })
);

export default r;
