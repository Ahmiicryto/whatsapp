import { one, many, query } from "../db/pool.js";
import { enqueue } from "../queue/queue.js";
import { zonedParts, startOfLocalDay, addDays, minutesOfDay } from "../lib/time.js";
import { formatMoney } from "../lib/format.js";
import * as wa from "../whatsapp/cloudApi.js";
import { aiAvailable } from "../ai/provider.js";
import { reportInsights } from "../ai/features.js";
import { computeMetrics } from "./metrics.js";
import { renderReportPdf } from "./reportPdf.js";
import { getStoreContext } from "./stores.js";
import { sendTemplate } from "./messaging.js";
import { logger } from "../logger.js";

const TITLES = { daily: "Daily report", weekly: "Weekly report", monthly: "Monthly report" };

/** Local period for a report type ending "now" in the store timezone. */
export function reportPeriod(type, timezone, now = new Date()) {
  const p = zonedParts(now, timezone);
  const todayStart = startOfLocalDay(p.dateKey, timezone);
  if (type === "daily") {
    return { from: todayStart, to: addDays(todayStart, 1), key: p.dateKey, label: p.dateKey, prevFrom: addDays(todayStart, -1), prevTo: todayStart, trendFrom: addDays(todayStart, -6) };
  }
  if (type === "weekly") {
    const from = addDays(todayStart, -6);
    return { from, to: addDays(todayStart, 1), key: `W-${p.dateKey}`, label: `7 days to ${p.dateKey}`, prevFrom: addDays(from, -7), prevTo: from, trendFrom: from };
  }
  const monthStart = startOfLocalDay(`${p.year}-${String(p.month).padStart(2, "0")}-01`, timezone);
  const prevMonth = p.month === 1 ? `${p.year - 1}-12-01` : `${p.year}-${String(p.month - 1).padStart(2, "0")}-01`;
  return {
    from: monthStart,
    to: addDays(todayStart, 1),
    key: `M-${p.dateKey.slice(0, 7)}`,
    label: `Month to date ${p.dateKey.slice(0, 7)}`,
    prevFrom: startOfLocalDay(prevMonth, timezone),
    prevTo: monthStart,
    trendFrom: monthStart,
  };
}

/**
 * Builds (or returns the existing) report for a store, or for a whole account when storeId is null.
 */
export async function generateReport({ accountId, storeId, type, now = new Date() }) {
  const store = storeId ? await getStoreContext(storeId) : null;
  const accountStores = await many(`SELECT id, name, timezone, currency FROM stores WHERE account_id=$1 AND status='active' ORDER BY id`, [accountId]);
  const primary = store || (accountStores[0] ? await getStoreContext(accountStores[0].id) : null);
  if (!primary) return null;
  const timezone = primary.timezone;
  const period = reportPeriod(type, timezone, now);

  const existing = await one(
    `SELECT * FROM reports WHERE account_id=$1 AND COALESCE(store_id,0)=COALESCE($2::bigint,0) AND type=$3 AND period_key=$4`,
    [accountId, storeId, type, period.key]
  );
  if (existing) return existing;

  const storeIds = store ? [store.id] : accountStores.map((s) => s.id);
  const [metrics, previous, trend] = await Promise.all([
    computeMetrics({ storeIds, from: period.from, to: period.to, timezone }),
    computeMetrics({ storeIds, from: period.prevFrom, to: period.prevTo, timezone }),
    computeMetrics({ storeIds, from: period.trendFrom, to: period.to, timezone }),
  ]);
  let insights = null;
  if (primary.settings.reports.aiSummary && aiAvailable(primary)) {
    try {
      insights = await reportInsights(primary, {
        type,
        currency: primary.currency,
        current: { kpis: metrics.kpis, messages: metrics.messages, topProducts: metrics.topProducts, topCities: metrics.topCities, campaigns: metrics.campaigns, carts: metrics.carts },
        previous: { kpis: previous.kpis, messages: previous.messages },
      });
    } catch (err) {
      logger.warn({ err: err.message }, "report AI insights failed");
    }
  }
  const data = {
    title: TITLES[type] || "Report",
    scopeName: store ? store.name : `All stores (${accountStores.length})`,
    periodLabel: period.label,
    currency: primary.currency,
    pricingCurrency: primary.settings.pricing.currency,
    metrics,
    previous: { kpis: previous.kpis, messages: previous.messages },
    trend: trend.series,
    insights,
  };
  const pdf = await renderReportPdf(data);
  return one(
    `INSERT INTO reports (account_id, store_id, type, period_key, data, pdf) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (account_id, COALESCE(store_id, 0), type, period_key) DO UPDATE SET data=EXCLUDED.data, pdf=EXCLUDED.pdf
     RETURNING *`,
    [accountId, storeId, type, period.key, data, pdf]
  );
}

/** Sends a generated report PDF to the owner numbers configured for it. */
export async function deliverReport(reportId, { onlyContactId } = {}) {
  const report = await one(`SELECT * FROM reports WHERE id=$1`, [reportId]);
  if (!report) return [];
  const contacts = await many(
    `SELECT * FROM owner_contacts WHERE account_id=$1 AND enabled AND $2 = ANY(reports)
       AND ${report.store_id ? "store_id = $3" : "store_id IS NULL AND $3::bigint IS NULL"}
       ${onlyContactId ? "AND id = $4" : ""}`,
    onlyContactId ? [report.account_id, report.type, report.store_id, onlyContactId] : [report.account_id, report.type, report.store_id]
  );
  if (!contacts.length) return [];
  const sender = report.store_id
    ? await getStoreContext(report.store_id)
    : await (async () => {
        const s = await one(`SELECT id FROM stores WHERE account_id=$1 AND whatsapp_number_id IS NOT NULL AND status='active' ORDER BY id LIMIT 1`, [report.account_id]);
        return s ? getStoreContext(s.id) : null;
      })();
  if (!sender?.wa) return [];

  const d = report.data;
  const k = d.metrics.kpis;
  const m = d.metrics.messages;
  const mediaId = await wa.uploadMedia(sender.wa, report.pdf, "application/pdf", `${d.title.replace(/\s+/g, "-")}-${report.period_key}.pdf`);
  const ctx = {
    __filename: `${d.title}-${report.period_key}.pdf`,
    "report.pdf": { id: mediaId },
    "report.title": d.title,
    "alert.store": d.scopeName,
    "report.date": d.periodLabel,
    "report.orders": String(k.orders),
    "report.revenue": formatMoney(k.revenue, d.currency),
    "report.confirmed": `${k.confirmed} (${k.confirmation_rate}%)`,
    "report.cancelled": String(Number(k.cancelled_by_customer) + Number(k.cancelled)),
    "report.pending": String(k.awaiting),
    "report.messages": String(m.sent),
    "report.read": `${m.read} (${m.read_rate}%)`,
    "report.summary": d.insights?.summary || `Delivery rate ${m.delivery_rate}%, ${k.no_response} orders without reply.`,
  };
  const sent = [...(report.sent_to || [])];
  for (const c of contacts) {
    try {
      await sendTemplate(sender, { kind: "daily_report", to: c.phone_e164, ctx, messageKind: "report", name: c.name });
      sent.push({ contactId: c.id, at: new Date().toISOString(), ok: true });
    } catch (err) {
      sent.push({ contactId: c.id, at: new Date().toISOString(), ok: false, error: err.message });
    }
  }
  await query(`UPDATE reports SET sent_to=$2 WHERE id=$1`, [report.id, JSON.stringify(sent)]);
  return sent;
}

/**
 * Cron (every 15 min): queue reports whose local send time has arrived.
 * Weekly reports go out on Mondays, monthly on the 1st (covering the previous period ending today).
 */
export async function queueDueReports(now = new Date()) {
  const stores = await many(
    `SELECT s.id, s.account_id FROM stores s JOIN accounts a ON a.id=s.account_id WHERE s.status='active' AND a.status='active'`
  );
  const accountsDone = new Set();
  for (const s of stores) {
    const store = await getStoreContext(s.id);
    const r = store.settings.reports;
    const p = zonedParts(now, store.timezone);
    const cur = p.hour * 60 + p.minute;
    const at = minutesOfDay(r.time);
    if (cur < at || cur >= at + 15) continue;
    const types = [];
    if (r.daily) types.push("daily");
    if (r.weekly && p.weekday === "Mon") types.push("weekly");
    if (r.monthly && p.day === 1) types.push("monthly");
    for (const type of types) {
      await enqueue("report.run", { storeId: s.id, accountId: s.account_id, type }, { singletonKey: `report:${s.id}:${type}:${p.dateKey}` });
      // Combined account report rides on the account's first store schedule.
      if (!accountsDone.has(`${s.account_id}:${type}`)) {
        accountsDone.add(`${s.account_id}:${type}`);
        const combined = await one(`SELECT 1 FROM owner_contacts WHERE account_id=$1 AND store_id IS NULL AND enabled LIMIT 1`, [s.account_id]);
        if (combined) {
          await enqueue("report.run", { accountId: s.account_id, storeId: null, type }, { singletonKey: `report:acct${s.account_id}:${type}:${p.dateKey}` });
        }
      }
    }
  }
}

export async function runReport({ accountId, storeId, type }) {
  const report = await generateReport({ accountId, storeId, type });
  if (!report) return;
  if ((report.sent_to || []).some((x) => x.ok)) return; // already delivered
  await deliverReport(report.id);
}
