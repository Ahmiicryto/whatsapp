import { Router } from "express";
import { z } from "zod";
import { one, many, query } from "../../db/pool.js";
import { ah, badRequest, notFound, forbidden } from "../../lib/errors.js";
import { requireRole, hashPassword, accessibleStoreIds } from "../auth.js";
import { audit } from "../../services/audit.js";
import { normalizePhone } from "../../lib/phone.js";
import { config } from "../../config.js";
import { generateReport, deliverReport } from "../../services/reports.js";

const r = Router();

r.get(
  "/team",
  requireRole("admin"),
  ah(async (req, res) => {
    res.json(
      await many(
        `SELECT u.id, u.email, u.name, u.status, u.last_login_at, m.role, m.store_ids
           FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=$1 ORDER BY m.role, u.name`,
        [req.accountId]
      )
    );
  })
);

const memberSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8).optional(),
  role: z.enum(["owner", "admin", "agent", "viewer"]),
  store_ids: z.array(z.number().int()).nullable().default(null),
});

async function validStoreIds(req, ids) {
  if (!ids) return null;
  const allowed = await accessibleStoreIds(req);
  if (ids.some((i) => !allowed.includes(i))) throw forbidden("Store not in this account");
  return ids;
}

r.post(
  "/team",
  requireRole("owner"),
  ah(async (req, res) => {
    const b = memberSchema.parse(req.body);
    const email = b.email.toLowerCase();
    let user = await one(`SELECT id FROM users WHERE email=$1`, [email]);
    if (!user) {
      if (!b.password) throw badRequest("Set a temporary password for the new user");
      user = await one(`INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id`, [email, await hashPassword(b.password), b.name]);
    }
    await query(
      `INSERT INTO memberships (user_id, account_id, role, store_ids) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, account_id) DO UPDATE SET role=EXCLUDED.role, store_ids=EXCLUDED.store_ids`,
      [user.id, req.accountId, b.role, await validStoreIds(req, b.store_ids)]
    );
    await audit({ user: req.user, accountId: req.accountId, action: "team.add", target: email, details: { role: b.role } });
    res.json({ ok: true, userId: user.id });
  })
);

r.patch(
  "/team/:userId",
  requireRole("owner"),
  ah(async (req, res) => {
    const b = z.object({ role: z.enum(["owner", "admin", "agent", "viewer"]), store_ids: z.array(z.number().int()).nullable() }).parse(req.body);
    if (Number(req.params.userId) === req.user.id && b.role !== "owner") {
      const owners = await one(`SELECT count(*) AS n FROM memberships WHERE account_id=$1 AND role='owner'`, [req.accountId]);
      if (Number(owners.n) <= 1) throw badRequest("An account needs at least one owner");
    }
    const row = await one(`UPDATE memberships SET role=$3, store_ids=$4 WHERE user_id=$1 AND account_id=$2 RETURNING user_id`, [
      req.params.userId,
      req.accountId,
      b.role,
      await validStoreIds(req, b.store_ids),
    ]);
    if (!row) throw notFound();
    await audit({ user: req.user, accountId: req.accountId, action: "team.update", target: String(req.params.userId), details: b });
    res.json({ ok: true });
  })
);

r.delete(
  "/team/:userId",
  requireRole("owner"),
  ah(async (req, res) => {
    if (Number(req.params.userId) === req.user.id) throw badRequest("You can't remove yourself");
    await query(`DELETE FROM memberships WHERE user_id=$1 AND account_id=$2`, [req.params.userId, req.accountId]);
    await query(`DELETE FROM sessions WHERE user_id=$1 AND active_account_id=$2`, [req.params.userId, req.accountId]);
    await audit({ user: req.user, accountId: req.accountId, action: "team.remove", target: String(req.params.userId) });
    res.json({ ok: true });
  })
);

// ---------- my profile: personal WhatsApp number + daily report for all my stores ----------

r.get(
  "/profile",
  ah(async (req, res) => {
    const u = await one(`SELECT id, email, name, phone_e164 FROM users WHERE id=$1`, [req.user.id]);
    const contact = req.accountId
      ? await one(`SELECT id, reports, enabled FROM owner_contacts WHERE user_id=$1 AND account_id=$2 AND store_id IS NULL`, [req.user.id, req.accountId])
      : null;
    res.json({ ...u, dailyReport: !!contact?.enabled && contact.reports.includes("daily"), alerts: !!contact?.enabled && contact.reports.includes("alerts") });
  })
);

r.put(
  "/profile",
  ah(async (req, res) => {
    const b = z.object({ name: z.string().min(1).max(100), phone: z.string().optional().default(""), dailyReport: z.boolean(), alerts: z.boolean().default(true) }).parse(req.body);
    const phone = b.phone ? normalizePhone(b.phone, config.defaults.country) : null;
    if (b.phone && !phone) throw badRequest("Enter a valid WhatsApp number with country code, e.g. +92 300 1234567");
    if ((b.dailyReport || b.alerts) && !phone) throw badRequest("Add your WhatsApp number to receive reports");
    await query(`UPDATE users SET name=$2, phone_e164=$3 WHERE id=$1`, [req.user.id, b.name, phone]);
    if (req.accountId) {
      const reports = [b.dailyReport && "daily", b.alerts && "alerts"].filter(Boolean);
      const existing = await one(`SELECT id FROM owner_contacts WHERE user_id=$1 AND account_id=$2 AND store_id IS NULL`, [req.user.id, req.accountId]);
      if (existing) {
        await query(`UPDATE owner_contacts SET name=$2, phone_e164=COALESCE($3, phone_e164), reports=$4, enabled=$5 WHERE id=$1`, [existing.id, b.name, phone, reports, reports.length > 0]);
      } else if (reports.length) {
        await query(
          `INSERT INTO owner_contacts (account_id, store_id, user_id, name, phone_e164, reports) VALUES ($1, NULL, $2, $3, $4, $5)`,
          [req.accountId, req.user.id, b.name, phone, reports]
        );
      }
    }
    res.json({ ok: true });
  })
);

/** Send my own daily report now (the profile must be saved with the daily report on). */
r.post(
  "/profile/test-report",
  ah(async (req, res) => {
    const c = req.accountId ? await one(`SELECT id FROM owner_contacts WHERE user_id=$1 AND account_id=$2 AND store_id IS NULL AND enabled`, [req.user.id, req.accountId]) : null;
    if (!c) throw badRequest("Save your WhatsApp number with the daily report turned on first");
    const report = await generateReport({ accountId: req.accountId, storeId: null, type: "daily" });
    if (!report) throw badRequest("No active store in this business yet");
    const sent = await deliverReport(report.id, { onlyContactId: c.id });
    if (!sent.length) throw badRequest("Nothing sent: connect a WhatsApp number to one of your stores first");
    const last = sent[sent.length - 1];
    if (!last.ok) throw badRequest(last.error);
    res.json({ ok: true });
  })
);

r.get(
  "/audit",
  requireRole("admin"),
  ah(async (req, res) => {
    res.json(
      await many(
        `SELECT a.*, u.email AS actor_email, i.email AS impersonator_email, s.name AS store_name
           FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id LEFT JOIN users i ON i.id=a.impersonator_id LEFT JOIN stores s ON s.id=a.store_id
          WHERE a.account_id=$1 OR a.store_id IN (SELECT id FROM stores WHERE account_id=$1)
          ORDER BY a.created_at DESC LIMIT 300`,
        [req.accountId]
      )
    );
  })
);

r.get(
  "/usage",
  ah(async (req, res) => {
    res.json(await many(`SELECT * FROM usage_counters WHERE account_id=$1 ORDER BY month DESC LIMIT 12`, [req.accountId]));
  })
);

export default r;
