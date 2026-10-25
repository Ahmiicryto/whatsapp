import { Router } from "express";
import { z } from "zod";
import { one, many, query } from "../../db/pool.js";
import { ah, badRequest, forbidden, notFound } from "../../lib/errors.js";
import { encrypt, randomToken } from "../../lib/crypto.js";
import { config } from "../../config.js";
import { requireRole, assertStore, accessibleStoreIds } from "../auth.js";
import { enqueue } from "../../queue/queue.js";
import { audit } from "../../services/audit.js";
import { getStoreContext, invalidateStore } from "../../services/stores.js";
import { resolveSettings, deepMerge, DEFAULT_SETTINGS } from "../../services/settings.js";
import { fetchShopInfo } from "../../shopify/client.js";
import { normalizeShopDomain, isValidShopDomain, buildInstallUrl } from "../../shopify/oauth.js";
import * as wa from "../../whatsapp/cloudApi.js";
import { normalizePhone, toWaId } from "../../lib/phone.js";

const r = Router();

function publicStore(row) {
  const { shopify_token_enc, webhook_secret_enc, ...rest } = row;
  return { ...rest, has_token: !!shopify_token_enc, has_custom_secret: !!webhook_secret_enc };
}

r.get(
  "/stores",
  ah(async (req, res) => {
    const ids = await accessibleStoreIds(req);
    if (!ids.length) return res.json([]);
    const rows = await many(
      `SELECT s.*, w.display_number, w.verified_name, w.quality_rating,
              (SELECT count(*) FROM orders o WHERE o.store_id=s.id AND o.shopify_created_at > now() - interval '24 hours') AS orders_24h,
              (SELECT count(*) FROM orders o WHERE o.store_id=s.id AND o.status='awaiting_reply') AS awaiting,
              (SELECT count(*) FROM jobs j WHERE j.store_id=s.id AND j.status='failed' AND j.updated_at > now() - interval '7 days') AS failed_jobs
         FROM stores s LEFT JOIN whatsapp_numbers w ON w.id = s.whatsapp_number_id
        WHERE s.id = ANY($1) ORDER BY s.name`,
      [ids]
    );
    res.json(rows.map(publicStore));
  })
);

const manualSchema = z.object({
  shopDomain: z.string().min(3),
  accessToken: z.string().min(10),
  webhookSecret: z.string().min(10),
  name: z.string().optional(),
});

r.post(
  "/stores",
  requireRole("admin"),
  ah(async (req, res) => {
    const body = manualSchema.parse(req.body);
    const shop = normalizeShopDomain(body.shopDomain);
    if (!isValidShopDomain(shop)) throw badRequest("Use the store's xxx.myshopify.com domain");
    const existing = await one(`SELECT id, account_id FROM stores WHERE lower(shopify_domain)=$1`, [shop]);
    if (existing && existing.account_id !== req.accountId) throw forbidden("This store is already connected to another account");

    let info;
    try {
      info = await fetchShopInfo({ id: 0, shopifyDomain: shop, shopifyToken: body.accessToken });
    } catch (err) {
      throw badRequest(`Could not connect to Shopify: ${err.message}`);
    }
    const row = await one(
      `INSERT INTO stores (account_id, name, shopify_domain, shopify_token_enc, webhook_secret_enc, connection_type, currency, timezone, country)
       VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,$8)
       ON CONFLICT (shopify_domain) DO UPDATE SET shopify_token_enc=EXCLUDED.shopify_token_enc, webhook_secret_enc=EXCLUDED.webhook_secret_enc,
         status='active', updated_at=now()
       RETURNING *`,
      [req.accountId, body.name || info.name, shop, encrypt(body.accessToken), encrypt(body.webhookSecret), info.currency, info.timezone, info.country]
    );
    invalidateStore(row.id);
    await enqueue("store.setup", { storeId: row.id }, { singletonKey: `store:${row.id}:setup` });
    await audit({ user: req.user, accountId: req.accountId, storeId: row.id, action: "store.connect", target: shop });
    res.json(publicStore(row));
  })
);

r.get(
  "/shopify/install",
  requireRole("admin"),
  ah(async (req, res) => {
    if (!config.shopify.apiKey) throw badRequest("Shopify OAuth isn't configured on this platform (SHOPIFY_API_KEY). Use a custom app token instead.");
    const shop = normalizeShopDomain(req.query.shop);
    if (!isValidShopDomain(shop)) throw badRequest("Use the store's xxx.myshopify.com domain");
    const state = randomToken(24);
    await query(`INSERT INTO oauth_states (state, user_id, account_id, shop) VALUES ($1,$2,$3,$4)`, [state, req.user.id, req.accountId, shop]);
    res.json({ url: buildInstallUrl(shop, state) });
  })
);

r.get(
  "/stores/:id",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id);
    const wn = store.whatsapp_number_id ? await one(`SELECT id, phone_number_id, waba_id, display_number, verified_name, quality_rating, messaging_limit, webhook_key, app_secret_enc IS NOT NULL AS own_app FROM whatsapp_numbers WHERE id=$1`, [store.whatsapp_number_id]) : null;
    const keys = await many(`SELECT provider FROM api_keys WHERE store_id=$1`, [store.id]);
    const failed = await one(`SELECT count(*) AS n FROM jobs WHERE store_id=$1 AND status='failed' AND updated_at > now() - interval '7 days'`, [store.id]);
    res.json({
      store: publicStore(store),
      settings: resolveSettings(store.settings),
      defaults: DEFAULT_SETTINGS,
      whatsapp: wn
        ? {
            ...wn,
            webhook_url: wn.own_app ? `${config.baseUrl}/webhooks/whatsapp/${wn.webhook_key}` : `${config.baseUrl}/webhooks/whatsapp`,
            verify_token: wn.own_app ? wn.webhook_key : config.meta.verifyToken,
          }
        : null,
      apiKeys: keys.map((k) => k.provider),
      platformKeys: { openai: !!config.openai.apiKey, gemini: !!config.gemini.apiKey, google: !!config.google.mapsKey },
      failedJobs: failed.n,
      webhookUrl: `${config.baseUrl}/webhooks/shopify`,
    });
  })
);

r.patch(
  "/stores/:id",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    const body = z
      .object({
        name: z.string().min(1).optional(),
        currency: z.string().length(3).optional(),
        timezone: z.string().optional(),
        country: z.string().length(2).optional(),
        logo_url: z.string().url().or(z.literal("")).optional(),
        status: z.enum(["active", "paused"]).optional(),
      })
      .parse(req.body);
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: body.timezone });
      } catch {
        throw badRequest("Unknown timezone");
      }
    }
    const row = await one(
      `UPDATE stores SET name=COALESCE($2,name), currency=COALESCE($3,currency), timezone=COALESCE($4,timezone),
         country=COALESCE($5,country), logo_url=COALESCE($6,logo_url), status=COALESCE($7,status), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [store.id, body.name, body.currency?.toUpperCase(), body.timezone, body.country?.toUpperCase(), body.logo_url, body.status]
    );
    invalidateStore(store.id);
    await audit({ user: req.user, accountId: store.account_id, storeId: store.id, action: "store.update", details: body });
    res.json(publicStore(row));
  })
);

r.put(
  "/stores/:id/settings",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    if (!req.body || typeof req.body !== "object") throw badRequest("settings object required");
    const merged = deepMerge(store.settings || {}, req.body);
    // keep only known top-level keys
    const clean = Object.fromEntries(Object.entries(merged).filter(([k]) => k in DEFAULT_SETTINGS));
    await query(`UPDATE stores SET settings=$2, updated_at=now() WHERE id=$1`, [store.id, clean]);
    invalidateStore(store.id);
    await audit({ user: req.user, accountId: store.account_id, storeId: store.id, action: "settings.update", details: Object.keys(req.body) });
    res.json(resolveSettings(clean));
  })
);

r.delete(
  "/stores/:id",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "owner");
    await query(`DELETE FROM stores WHERE id=$1`, [store.id]);
    invalidateStore(store.id);
    await audit({ user: req.user, accountId: store.account_id, action: "store.delete", target: store.shopify_domain });
    res.json({ ok: true });
  })
);

r.post(
  "/stores/:id/setup",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    await enqueue("store.setup", { storeId: store.id }, { singletonKey: `store:${store.id}:setup` });
    res.json({ queued: true });
  })
);

r.post(
  "/stores/:id/backfill",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    const days = Math.min(365, Math.max(1, Number(req.body.days || 30)));
    await enqueue("store.backfill", { storeId: store.id, days }, { singletonKey: `store:${store.id}:backfill` });
    res.json({ queued: true });
  })
);

// ---------- WhatsApp number ----------

r.get(
  "/whatsapp-numbers",
  requireRole("admin"),
  ah(async (req, res) => {
    res.json(
      await many(
        `SELECT w.id, w.display_number, w.verified_name, w.quality_rating, w.phone_number_id,
                (SELECT json_agg(s.name) FROM stores s WHERE s.whatsapp_number_id=w.id) AS stores
           FROM whatsapp_numbers w WHERE w.account_id=$1 ORDER BY w.id`,
        [req.accountId]
      )
    );
  })
);

const waSchema = z.union([
  z.object({ numberId: z.number().int() }),
  z.object({
    phoneNumberId: z.string().min(5),
    wabaId: z.string().min(5),
    accessToken: z.string().min(20),
    appSecret: z.string().optional().or(z.literal("")),
  }),
]);

r.post(
  "/stores/:id/whatsapp",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    const body = waSchema.parse(req.body);
    let numberId;
    if ("numberId" in body) {
      const n = await one(`SELECT id FROM whatsapp_numbers WHERE id=$1 AND account_id=$2`, [body.numberId, store.account_id]);
      if (!n) throw notFound("Number not found");
      numberId = n.id;
    } else {
      const owner = await one(`SELECT account_id FROM whatsapp_numbers WHERE phone_number_id=$1`, [body.phoneNumberId]);
      if (owner && owner.account_id !== store.account_id) throw forbidden("This WhatsApp number is linked to another account");
      const creds = { phoneNumberId: body.phoneNumberId, wabaId: body.wabaId, token: body.accessToken };
      let info;
      try {
        info = await wa.getPhoneNumberInfo(creds);
      } catch (err) {
        throw badRequest(`Meta rejected these credentials: ${err.message}`);
      }
      try {
        await wa.subscribeApp(creds);
      } catch (err) {
        throw badRequest(`Could not subscribe the app to your WhatsApp Business Account: ${err.message}`);
      }
      const row = await one(
        `INSERT INTO whatsapp_numbers (account_id, phone_number_id, waba_id, display_number, verified_name, token_enc, app_secret_enc,
            webhook_key, quality_rating, messaging_limit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (phone_number_id) DO UPDATE SET waba_id=EXCLUDED.waba_id, token_enc=EXCLUDED.token_enc,
           app_secret_enc=EXCLUDED.app_secret_enc, display_number=EXCLUDED.display_number, verified_name=EXCLUDED.verified_name,
           quality_rating=EXCLUDED.quality_rating, messaging_limit=EXCLUDED.messaging_limit, updated_at=now()
         RETURNING id`,
        [
          store.account_id,
          body.phoneNumberId,
          body.wabaId,
          info.display_phone_number,
          info.verified_name,
          encrypt(body.accessToken),
          body.appSecret ? encrypt(body.appSecret) : null,
          randomToken(16),
          info.quality_rating,
          info.messaging_limit_tier || null,
        ]
      );
      numberId = row.id;
    }
    await query(`UPDATE stores SET whatsapp_number_id=$2, updated_at=now() WHERE id=$1`, [store.id, numberId]);
    invalidateStore(store.id);
    await enqueue("templates.install", { storeId: store.id }, { singletonKey: `store:${store.id}:templates` });
    await audit({ user: req.user, accountId: store.account_id, storeId: store.id, action: "whatsapp.link" });
    res.json({ ok: true, numberId });
  })
);

r.delete(
  "/stores/:id/whatsapp",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    await query(`UPDATE stores SET whatsapp_number_id=NULL WHERE id=$1`, [store.id]);
    invalidateStore(store.id);
    res.json({ ok: true });
  })
);

r.post(
  "/stores/:id/whatsapp/test",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    const ctx = await getStoreContext(store.id);
    if (!ctx.wa) throw badRequest("No WhatsApp number linked");
    const to = normalizePhone(req.body.phone, ctx.country);
    if (!to) throw badRequest("Enter a valid phone number");
    // hello_world exists in every new WhatsApp Business Account
    const wamid = await wa
      .sendMessage(ctx.wa, toWaId(to), { type: "template", template: { name: "hello_world", language: { code: "en_US" } } })
      .catch((err) => {
        throw badRequest(err.message);
      });
    res.json({ ok: true, wamid });
  })
);

r.put(
  "/stores/:id/api-keys",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    const { provider, key } = z.object({ provider: z.enum(["openai", "gemini", "google"]), key: z.string().optional() }).parse(req.body);
    if (!key) await query(`DELETE FROM api_keys WHERE store_id=$1 AND provider=$2`, [store.id, provider]);
    else {
      await query(
        `INSERT INTO api_keys (store_id, provider, key_enc) VALUES ($1,$2,$3) ON CONFLICT (store_id, provider) DO UPDATE SET key_enc=EXCLUDED.key_enc`,
        [store.id, provider, encrypt(key)]
      );
    }
    invalidateStore(store.id);
    await audit({ user: req.user, accountId: store.account_id, storeId: store.id, action: "apikey.update", target: provider });
    res.json({ ok: true });
  })
);

// ---------- jobs / logs ----------

r.get(
  "/jobs",
  ah(async (req, res) => {
    const ids = await accessibleStoreIds(req);
    res.json(
      await many(
        `SELECT id, name, store_id, status, attempts, last_error, run_at, updated_at, data->>'orderId' AS order_id
           FROM jobs WHERE store_id = ANY($1) AND status = $2 ORDER BY updated_at DESC LIMIT 200`,
        [ids, req.query.status || "failed"]
      )
    );
  })
);

r.post(
  "/jobs/:id/retry",
  requireRole("admin"),
  ah(async (req, res) => {
    const ids = await accessibleStoreIds(req);
    const job = await one(`UPDATE jobs SET status='queued', attempts=0, run_at=now(), updated_at=now() WHERE id=$1 AND store_id = ANY($2) AND status='failed' RETURNING id`, [req.params.id, ids]);
    if (!job) throw notFound("Job not found");
    res.json({ ok: true });
  })
);

export default r;
