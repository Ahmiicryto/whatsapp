import { Router } from "express";
import { z } from "zod";
import { one, many, query } from "../../db/pool.js";
import { ah, badRequest, notFound } from "../../lib/errors.js";
import { normalizePhone } from "../../lib/phone.js";
import { requireRole, accessibleStoreIds, assertStore, scopeStoreIds } from "../auth.js";
import { generateReport, deliverReport } from "../../services/reports.js";
import { computeMetrics } from "../../services/metrics.js";
import { getStoreContext } from "../../services/stores.js";
import { askData } from "../../ai/features.js";
import { aiAvailable } from "../../ai/provider.js";
import { sign } from "../../lib/crypto.js";
import { config } from "../../config.js";

const r = Router();

// ---------------------------------------------------------------- dashboard

function range(req) {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 86400000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest("Invalid date range");
  return { from, to };
}

r.get(
  "/dashboard",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const { from, to } = range(req);
    const tzRow = storeIds.length ? await one(`SELECT timezone, currency FROM stores WHERE id=$1`, [storeIds[0]]) : null;
    const metrics = await computeMetrics({ storeIds, from, to, timezone: tzRow?.timezone || config.defaults.timezone });
    let mapUrl = null;
    if (metrics.mapPoints.length && config.google.mapsKey) {
      const v = metrics.mapPoints.map((p) => `${Number(p.lat).toFixed(4)}:${Number(p.lng).toFixed(4)}`).join(";");
      mapUrl = `/media/orders-map?v=${encodeURIComponent(v)}&s=${sign(v)}`;
    }
    res.json({ ...metrics, currency: tzRow?.currency || config.defaults.currency, mapUrl, stores: storeIds.length });
  })
);

r.post(
  "/ai/ask",
  ah(async (req, res) => {
    const { question, storeId } = z.object({ question: z.string().min(3).max(500), storeId: z.union([z.number().int(), z.literal("all")]).default("all") }).parse(req.body);
    const ids = await accessibleStoreIds(req);
    const storeIds = storeId === "all" ? ids : ids.filter((i) => i === storeId);
    if (!storeIds.length) throw badRequest("No store selected");
    const store = await getStoreContext(storeIds[0]);
    if (!aiAvailable(store)) throw badRequest("AI is not configured");
    const now = new Date();
    const [last30, last7, prev7, today] = await Promise.all([
      computeMetrics({ storeIds, from: new Date(now - 30 * 86400000), to: now, timezone: store.timezone }),
      computeMetrics({ storeIds, from: new Date(now - 7 * 86400000), to: now, timezone: store.timezone }),
      computeMetrics({ storeIds, from: new Date(now - 14 * 86400000), to: new Date(now - 7 * 86400000), timezone: store.timezone }),
      computeMetrics({ storeIds, from: new Date(now - 86400000), to: now, timezone: store.timezone }),
    ]);
    const stores = await many(`SELECT id, name, currency FROM stores WHERE id = ANY($1)`, [storeIds]);
    const perStore = await many(
      `SELECT store_id, count(*) AS orders_30d, COALESCE(sum(total),0) AS revenue_30d,
              count(*) FILTER (WHERE status='confirmed' OR confirmed_at IS NOT NULL) AS confirmed_30d,
              count(*) FILTER (WHERE status='cancelled_by_customer') AS cancelled_30d
         FROM orders WHERE store_id = ANY($1) AND shopify_created_at > now() - interval '30 days' GROUP BY store_id`,
      [storeIds]
    );
    const strip = (m) => ({ kpis: m.kpis, messages: m.messages, topProducts: m.topProducts, topCities: m.topCities, campaigns: m.campaigns, carts: m.carts, statuses: m.statuses });
    const answer = await askData(store, question, {
      now: now.toISOString(),
      stores,
      perStore,
      last24h: strip(today),
      last7days: { ...strip(last7), daily: last7.series },
      previous7days: strip(prev7),
      last30days: { ...strip(last30), daily: last30.series },
    });
    res.json({ answer });
  })
);

// ---------------------------------------------------------------- reports

r.get(
  "/reports",
  ah(async (req, res) => {
    const ids = await accessibleStoreIds(req);
    res.json(
      await many(
        `SELECT r.id, r.store_id, s.name AS store_name, r.type, r.period_key, r.sent_to, r.created_at,
                r.data->'metrics'->'kpis' AS kpis, r.data->'insights' AS insights
           FROM reports r LEFT JOIN stores s ON s.id=r.store_id
          WHERE r.account_id=$1 AND (r.store_id IS NULL OR r.store_id = ANY($2)) ORDER BY r.created_at DESC LIMIT 100`,
        [req.accountId, ids]
      )
    );
  })
);

r.get(
  "/reports/:id/pdf",
  ah(async (req, res) => {
    const ids = await accessibleStoreIds(req);
    const report = await one(`SELECT * FROM reports WHERE id=$1 AND (account_id=$2 OR $3) AND (store_id IS NULL OR store_id = ANY($4) OR $3)`, [
      req.params.id,
      req.accountId,
      !!req.user.isSuperAdmin,
      ids,
    ]);
    if (!report?.pdf) throw notFound();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="report-${report.type}-${report.period_key}.pdf"`);
    res.send(report.pdf);
  })
);

r.post(
  "/reports/run",
  requireRole("admin"),
  ah(async (req, res) => {
    const { storeId, type, send } = z.object({ storeId: z.number().int().nullable(), type: z.enum(["daily", "weekly", "monthly"]), send: z.boolean().default(false) }).parse(req.body);
    if (storeId) await assertStore(req, storeId, "admin");
    // regenerate on demand
    await query(`DELETE FROM reports WHERE account_id=$1 AND COALESCE(store_id,0)=COALESCE($2::bigint,0) AND type=$3 AND created_at > now() - interval '2 days' AND sent_to = '[]'::jsonb`, [req.accountId, storeId, type]);
    const report = await generateReport({ accountId: req.accountId, storeId, type });
    if (!report) throw badRequest("No active store in this account");
    const sent = send ? await deliverReport(report.id) : [];
    res.json({ id: report.id, sent });
  })
);

// ---------------------------------------------------------------- owner numbers

const contactSchema = z.object({
  name: z.string().min(1).max(100),
  phone: z.string().min(5),
  store_id: z.number().int().nullable().optional(),
  reports: z.array(z.enum(["daily", "weekly", "monthly", "alerts"])).default(["daily", "alerts"]),
  language: z.string().default("en"),
  enabled: z.boolean().default(true),
});

r.get(
  "/owner-contacts",
  ah(async (req, res) => {
    res.json(await many(`SELECT o.*, s.name AS store_name FROM owner_contacts o LEFT JOIN stores s ON s.id=o.store_id WHERE o.account_id=$1 ORDER BY o.id`, [req.accountId]));
  })
);

async function contactValues(req, b) {
  if (b.store_id) await assertStore(req, b.store_id, "admin");
  const first = b.store_id ? await getStoreContext(b.store_id) : null;
  const phone = normalizePhone(b.phone, first?.country || config.defaults.country);
  if (!phone) throw badRequest("Invalid phone number");
  return [b.name, phone, b.store_id ?? null, b.reports, b.language, b.enabled];
}

r.post(
  "/owner-contacts",
  requireRole("admin"),
  ah(async (req, res) => {
    const b = contactSchema.parse(req.body);
    const v = await contactValues(req, b);
    res.json(await one(`INSERT INTO owner_contacts (account_id, name, phone_e164, store_id, reports, language, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.accountId, ...v]));
  })
);

r.put(
  "/owner-contacts/:id",
  requireRole("admin"),
  ah(async (req, res) => {
    const b = contactSchema.parse(req.body);
    const v = await contactValues(req, b);
    const row = await one(
      `UPDATE owner_contacts SET name=$3, phone_e164=$4, store_id=$5, reports=$6, language=$7, enabled=$8 WHERE id=$1 AND account_id=$2 RETURNING *`,
      [req.params.id, req.accountId, ...v]
    );
    if (!row) throw notFound();
    res.json(row);
  })
);

r.delete(
  "/owner-contacts/:id",
  requireRole("admin"),
  ah(async (req, res) => {
    await query(`DELETE FROM owner_contacts WHERE id=$1 AND account_id=$2`, [req.params.id, req.accountId]);
    res.json({ ok: true });
  })
);

r.post(
  "/owner-contacts/:id/test",
  requireRole("admin"),
  ah(async (req, res) => {
    const c = await one(`SELECT * FROM owner_contacts WHERE id=$1 AND account_id=$2`, [req.params.id, req.accountId]);
    if (!c) throw notFound();
    const report = await generateReport({ accountId: req.accountId, storeId: c.store_id, type: "daily" });
    if (!report) throw badRequest("No active store in this account");
    const sent = await deliverReport(report.id, { onlyContactId: c.id });
    if (!sent.length) throw badRequest("Nothing sent: check the contact has the daily report enabled and the store has a WhatsApp number");
    const last = sent[sent.length - 1];
    if (!last.ok) throw badRequest(last.error);
    res.json({ ok: true });
  })
);

export default r;
