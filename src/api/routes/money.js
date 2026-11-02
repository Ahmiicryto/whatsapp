/** Parcel scanning, finance overview and Meta Ads connections. */
import { Router } from "express";
import { z } from "zod";
import { one, many, query } from "../../db/pool.js";
import { ah, badRequest } from "../../lib/errors.js";
import { encrypt } from "../../lib/crypto.js";
import { assertStore, scopeStoreIds } from "../auth.js";
import { audit } from "../../services/audit.js";
import { getStoreContext } from "../../services/stores.js";
import { enqueue } from "../../queue/queue.js";
import { scanParcel, recentScans, scanSummary, SCAN_ACTIONS } from "../../services/scan.js";
import { financeOverview } from "../../services/finance.js";
import { fetchAccount, normalizeAccountId, syncAdAccount } from "../../services/metaAds.js";

const r = Router();

// ---------------------------------------------------------------- scanning

r.post(
  "/scan",
  ah(async (req, res) => {
    const b = z.object({ code: z.string().min(1).max(120), action: z.enum(SCAN_ACTIONS).default("lookup") }).parse(req.body);
    if (b.action !== "lookup" && req.membership?.role === "viewer" && !req.user.isSuperAdmin) throw badRequest("Viewers can only look up parcels");
    res.json(await scanParcel({ storeIds: await scopeStoreIds(req), code: b.code, action: b.action, userId: req.user.id }));
  })
);

r.get(
  "/scan/recent",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const [rows, summary] = await Promise.all([recentScans(storeIds), scanSummary(storeIds)]);
    res.json({ rows, summary });
  })
);

// ---------------------------------------------------------------- finance

r.get(
  "/finance",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));
    const store = storeIds.length ? await getStoreContext(storeIds[0]) : null;
    const data = await financeOverview({ storeIds, from: new Date(Date.now() - days * 86400000), to: new Date(), timezone: store?.timezone || "UTC" });
    res.json({ ...data, currency: store?.currency || "USD", days });
  })
);

// ---------------------------------------------------------------- Meta Ads (Marketing API)

const publicAccount = (a) => ({ id: a.id, account_id: a.account_id, name: a.name, currency: a.currency, fx_rate: Number(a.fx_rate), last_synced_at: a.last_synced_at, last_error: a.last_error });

r.get(
  "/stores/:id/ad-accounts",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id);
    res.json((await many(`SELECT * FROM ad_accounts WHERE store_id=$1 ORDER BY id`, [store.id])).map(publicAccount));
  })
);

r.post(
  "/stores/:id/ad-accounts",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    const b = z.object({ accountId: z.string().min(3), accessToken: z.string().min(20), fxRate: z.number().positive().default(1) }).parse(req.body);
    const accountId = normalizeAccountId(b.accountId);
    if (!accountId) throw badRequest("Enter the ad account ID (the number after act_ in Ads Manager)");
    let info;
    try {
      info = await fetchAccount(accountId, b.accessToken.trim());
    } catch (err) {
      throw badRequest(`Meta rejected this: ${err.message}. The token needs the ads_read permission for this ad account.`);
    }
    const row = await one(
      `INSERT INTO ad_accounts (store_id, provider, account_id, name, currency, fx_rate, token_enc) VALUES ($1,'meta',$2,$3,$4,$5,$6)
       ON CONFLICT (store_id, provider, account_id) DO UPDATE SET name=EXCLUDED.name, currency=EXCLUDED.currency, fx_rate=EXCLUDED.fx_rate, token_enc=EXCLUDED.token_enc, last_error=NULL
       RETURNING *`,
      [store.id, accountId, info.name, info.currency, b.fxRate, encrypt(b.accessToken.trim())]
    );
    await audit({ user: req.user, accountId: store.account_id, storeId: store.id, action: "ads.meta.connect", target: accountId });
    await enqueue("ads.sync", { storeId: store.id, adAccountId: row.id, days: 60 }, { singletonKey: `ads:${row.id}:sync` });
    res.json(publicAccount(row));
  })
);

r.put(
  "/stores/:id/ad-accounts/:aid",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    const { fxRate } = z.object({ fxRate: z.number().positive() }).parse(req.body);
    const row = await one(`UPDATE ad_accounts SET fx_rate=$3 WHERE id=$1 AND store_id=$2 RETURNING *`, [req.params.aid, store.id, fxRate]);
    if (!row) throw badRequest("Ad account not found");
    await enqueue("ads.sync", { storeId: store.id, adAccountId: row.id, days: 60 }, { singletonKey: `ads:${row.id}:sync` });
    res.json(publicAccount(row));
  })
);

r.post(
  "/stores/:id/ad-accounts/:aid/sync",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    const row = await one(`SELECT id FROM ad_accounts WHERE id=$1 AND store_id=$2`, [req.params.aid, store.id]);
    if (!row) throw badRequest("Ad account not found");
    try {
      res.json({ days: await syncAdAccount(row.id, { days: Number(req.body?.days || 30) }) });
    } catch (err) {
      throw badRequest(err.message);
    }
  })
);

r.delete(
  "/stores/:id/ad-accounts/:aid",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    await query(`DELETE FROM ad_accounts WHERE id=$1 AND store_id=$2`, [req.params.aid, store.id]);
    res.json({ ok: true });
  })
);

export default r;
