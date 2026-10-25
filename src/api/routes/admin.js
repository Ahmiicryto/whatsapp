import { Router } from "express";
import { z } from "zod";
import { one, many, query } from "../../db/pool.js";
import { ah, notFound, badRequest } from "../../lib/errors.js";
import { requireSuperAdmin, createSession, destroySession } from "../auth.js";
import { computeMetrics } from "../../services/metrics.js";
import { audit } from "../../services/audit.js";
import { invalidateStore } from "../../services/stores.js";
import { config } from "../../config.js";

const r = Router();
r.use(requireSuperAdmin);

r.get(
  "/overview",
  ah(async (req, res) => {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 86400000);
    const metrics = await computeMetrics({ storeIds: null, from, to, timezone: config.defaults.timezone });
    const totals = await one(
      `SELECT (SELECT count(*) FROM accounts) AS accounts, (SELECT count(*) FROM accounts WHERE status='suspended') AS suspended,
              (SELECT count(*) FROM stores) AS stores, (SELECT count(*) FROM stores WHERE status='active') AS active_stores,
              (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM whatsapp_numbers) AS numbers,
              (SELECT count(*) FROM jobs WHERE status='failed' AND updated_at > now() - interval '24 hours') AS failed_jobs_24h,
              (SELECT count(*) FROM jobs WHERE status='queued' AND run_at <= now()) AS queue_backlog`
    );
    const topStores = await many(
      `SELECT s.id, s.name, a.name AS account, count(o.id) AS orders, COALESCE(sum(o.total),0) AS revenue
         FROM stores s JOIN accounts a ON a.id=s.account_id LEFT JOIN orders o ON o.store_id=s.id AND o.shopify_created_at >= $1 AND o.shopify_created_at < $2
        GROUP BY s.id, a.name ORDER BY orders DESC LIMIT 10`,
      [from, to]
    );
    res.json({ totals, metrics, topStores });
  })
);

r.get(
  "/accounts",
  ah(async (req, res) => {
    res.json(
      await many(
        `SELECT a.*, (SELECT count(*) FROM stores s WHERE s.account_id=a.id) AS stores,
                (SELECT count(*) FROM memberships m WHERE m.account_id=a.id) AS users,
                (SELECT json_agg(u.email) FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=a.id AND m.role='owner') AS owners,
                (SELECT count(*) FROM orders o JOIN stores s ON s.id=o.store_id WHERE s.account_id=a.id AND o.shopify_created_at > now() - interval '30 days') AS orders_30d,
                (SELECT row_to_json(u) FROM usage_counters u WHERE u.account_id=a.id ORDER BY month DESC LIMIT 1) AS usage
           FROM accounts a ORDER BY a.created_at DESC`
      )
    );
  })
);

r.patch(
  "/accounts/:id",
  ah(async (req, res) => {
    const b = z.object({ status: z.enum(["active", "suspended"]).optional(), plan: z.string().optional(), limits: z.record(z.any()).optional(), name: z.string().optional() }).parse(req.body);
    const row = await one(
      `UPDATE accounts SET status=COALESCE($2,status), plan=COALESCE($3,plan), limits=COALESCE($4,limits), name=COALESCE($5,name) WHERE id=$1 RETURNING *`,
      [req.params.id, b.status, b.plan, b.limits, b.name]
    );
    if (!row) throw notFound();
    const stores = await many(`SELECT id FROM stores WHERE account_id=$1`, [row.id]);
    stores.forEach((s) => invalidateStore(s.id));
    await audit({ user: req.user, accountId: row.id, action: "admin.account.update", details: b });
    res.json(row);
  })
);

r.get(
  "/stores",
  ah(async (req, res) => {
    res.json(
      await many(
        `SELECT s.id, s.name, s.shopify_domain, s.status, s.connection_type, s.created_at, s.last_reconciled_at, a.id AS account_id, a.name AS account,
                w.display_number, w.quality_rating,
                (SELECT count(*) FROM orders o WHERE o.store_id=s.id) AS orders,
                (SELECT count(*) FROM messages m WHERE m.store_id=s.id AND m.created_at > now() - interval '30 days') AS messages_30d,
                (SELECT count(*) FROM jobs j WHERE j.store_id=s.id AND j.status='failed') AS failed_jobs
           FROM stores s JOIN accounts a ON a.id=s.account_id LEFT JOIN whatsapp_numbers w ON w.id=s.whatsapp_number_id
          ORDER BY s.created_at DESC`
      )
    );
  })
);

r.get(
  "/users",
  ah(async (req, res) => {
    res.json(
      await many(
        `SELECT u.id, u.email, u.name, u.is_super_admin, u.status, u.last_login_at, u.created_at,
                (SELECT json_agg(json_build_object('account', a.name, 'account_id', a.id, 'role', m.role))
                   FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=u.id) AS accounts
           FROM users u ORDER BY u.created_at DESC LIMIT 500`
      )
    );
  })
);

r.patch(
  "/users/:id",
  ah(async (req, res) => {
    const b = z.object({ status: z.enum(["active", "disabled"]) }).parse(req.body);
    if (Number(req.params.id) === req.user.id) throw badRequest("You can't disable yourself");
    await query(`UPDATE users SET status=$2 WHERE id=$1`, [req.params.id, b.status]);
    if (b.status === "disabled") await query(`DELETE FROM sessions WHERE user_id=$1`, [req.params.id]);
    await audit({ user: req.user, action: "admin.user.update", target: String(req.params.id), details: b });
    res.json({ ok: true });
  })
);

r.get(
  "/orders",
  ah(async (req, res) => {
    const params = [];
    let where = "TRUE";
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where = `(o.name ILIKE $1 OR o.customer_name ILIKE $1 OR o.phone_e164 ILIKE $1 OR s.name ILIKE $1)`;
    }
    res.json(
      await many(
        `SELECT o.id, o.name, o.store_id, s.name AS store_name, a.name AS account, o.customer_name, o.phone_e164, o.total, o.currency,
                o.status, o.address_status, o.risk_score, o.shopify_created_at
           FROM orders o JOIN stores s ON s.id=o.store_id JOIN accounts a ON a.id=s.account_id
          WHERE ${where} ORDER BY o.shopify_created_at DESC LIMIT 200`,
        params
      )
    );
  })
);

r.get(
  "/messages",
  ah(async (req, res) => {
    const params = [];
    const where = [];
    if (req.query.status) {
      params.push(req.query.status);
      where.push(`m.status = $${params.length}`);
    }
    res.json(
      await many(
        `SELECT m.id, m.store_id, s.name AS store_name, m.direction, m.kind, m.template_name, m.status, m.error_text, m.to_phone, m.body, m.created_at
           FROM messages m JOIN stores s ON s.id=m.store_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY m.created_at DESC LIMIT 300`,
        params
      )
    );
  })
);

r.get(
  "/jobs",
  ah(async (req, res) => {
    const stats = await many(`SELECT name, status, count(*) AS n FROM jobs WHERE updated_at > now() - interval '24 hours' GROUP BY 1,2 ORDER BY 1,2`);
    const failed = await many(
      `SELECT j.id, j.name, j.store_id, s.name AS store_name, j.attempts, j.last_error, j.updated_at FROM jobs j LEFT JOIN stores s ON s.id=j.store_id
        WHERE j.status='failed' ORDER BY j.updated_at DESC LIMIT 200`
    );
    res.json({ stats, failed });
  })
);

r.post(
  "/jobs/:id/retry",
  ah(async (req, res) => {
    const row = await one(`UPDATE jobs SET status='queued', attempts=0, run_at=now(), updated_at=now() WHERE id=$1 AND status='failed' RETURNING id`, [req.params.id]);
    if (!row) throw notFound();
    res.json({ ok: true });
  })
);

r.get(
  "/audit",
  ah(async (req, res) => {
    res.json(
      await many(
        `SELECT a.*, u.email AS actor_email, i.email AS impersonator_email, ac.name AS account_name
           FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id LEFT JOIN users i ON i.id=a.impersonator_id LEFT JOIN accounts ac ON ac.id=a.account_id
          ORDER BY a.created_at DESC LIMIT 500`
      )
    );
  })
);

/** View the portal as a user. Logged, and the UI shows a banner while impersonating. */
r.post(
  "/impersonate",
  ah(async (req, res) => {
    const { userId } = z.object({ userId: z.number().int() }).parse(req.body);
    const target = await one(`SELECT id, email FROM users WHERE id=$1`, [userId]);
    if (!target) throw notFound();
    await audit({ user: req.user, action: "admin.impersonate", target: target.email });
    await destroySession(req, res);
    await createSession(res, target.id, { impersonatorId: req.user.id });
    res.json({ ok: true });
  })
);

/** Switch the super admin's active account to view any merchant's data. */
r.post(
  "/view-account",
  ah(async (req, res) => {
    const { accountId } = z.object({ accountId: z.number().int() }).parse(req.body);
    await query(`UPDATE sessions SET active_account_id=$2 WHERE id=$1`, [req.sessionId, accountId]);
    await audit({ user: req.user, accountId, action: "admin.view_account" });
    res.json({ ok: true });
  })
);

export default r;
