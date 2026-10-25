import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { one, many, query, tx } from "../../db/pool.js";
import { ah, badRequest, unauthorized, forbidden } from "../../lib/errors.js";
import { config } from "../../config.js";
import { hashPassword, checkPassword, createSession, destroySession, requireAuth, accessibleStoreIds } from "../auth.js";
import { audit } from "../../services/audit.js";

const r = Router();
// Key by the client IP from the proxy header ourselves: serverless platforms (Vercel) don't always
// give Express a usable socket address, which makes the default key generator fail.
const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIp,
  validate: false,
});

const signupSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  accountName: z.string().min(1).max(100),
});

r.post(
  "/signup",
  limiter,
  ah(async (req, res) => {
    if (!config.allowSignup) throw forbidden("Sign-ups are disabled. Ask an administrator for an invite.");
    const body = signupSchema.parse(req.body);
    const email = body.email.toLowerCase();
    if (await one(`SELECT 1 FROM users WHERE email=$1`, [email])) throw badRequest("An account with this email already exists");
    const hash = await hashPassword(body.password);
    const { user, account } = await tx(async (c) => {
      const user = (await c.query(`INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id`, [email, hash, body.name])).rows[0];
      const account = (await c.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [body.accountName])).rows[0];
      await c.query(`INSERT INTO memberships (user_id, account_id, role) VALUES ($1,$2,'owner')`, [user.id, account.id]);
      return { user, account };
    });
    await createSession(res, user.id, { accountId: account.id });
    await audit({ user: { id: user.id }, accountId: account.id, action: "signup" });
    res.json({ ok: true });
  })
);

r.post(
  "/login",
  limiter,
  ah(async (req, res) => {
    const { email, password } = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const user = await one(`SELECT * FROM users WHERE email=$1`, [email.toLowerCase()]);
    if (!user || !(await checkPassword(password, user.password_hash))) throw unauthorized("Wrong email or password");
    if (user.status !== "active") throw forbidden("This user is disabled");
    await query(`UPDATE users SET last_login_at=now() WHERE id=$1`, [user.id]);
    await createSession(res, user.id);
    res.json({ ok: true });
  })
);

r.post(
  "/logout",
  ah(async (req, res) => {
    await destroySession(req, res);
    res.json({ ok: true });
  })
);

r.get(
  "/me",
  requireAuth,
  ah(async (req, res) => {
    const storeIds = await accessibleStoreIds(req);
    const stores = storeIds.length
      ? await many(
          `SELECT s.id, s.name, s.shopify_domain, s.status, s.currency, s.timezone, s.whatsapp_number_id IS NOT NULL AS has_whatsapp
             FROM stores s WHERE s.id = ANY($1) ORDER BY s.name`,
          [storeIds]
        )
      : [];
    let accounts = req.memberships.map((m) => ({ id: m.account_id, name: m.account_name, role: m.role, status: m.account_status }));
    if (req.user.isSuperAdmin && req.accountId && !accounts.some((a) => a.id === req.accountId)) {
      const a = await one(`SELECT id, name, status FROM accounts WHERE id=$1`, [req.accountId]);
      if (a) accounts = [...accounts, { ...a, role: "owner", viaSuperAdmin: true }];
    }
    res.json({
      user: req.user,
      accountId: req.accountId,
      role: req.user.isSuperAdmin ? "owner" : req.membership?.role || null,
      accounts,
      stores,
      impersonating: !!req.user.impersonatorId,
      features: { signup: config.allowSignup, shopifyOAuth: !!(config.shopify.apiKey && config.shopify.apiSecret) },
    });
  })
);

r.post(
  "/switch-account",
  requireAuth,
  ah(async (req, res) => {
    const accountId = Number(req.body.accountId);
    if (!req.user.isSuperAdmin && !req.memberships.some((m) => m.account_id === accountId)) throw forbidden();
    await query(`UPDATE sessions SET active_account_id=$2 WHERE id=$1`, [req.sessionId, accountId]);
    res.json({ ok: true });
  })
);

r.post(
  "/change-password",
  requireAuth,
  ah(async (req, res) => {
    const { current, next } = z.object({ current: z.string(), next: z.string().min(8) }).parse(req.body);
    const user = await one(`SELECT password_hash FROM users WHERE id=$1`, [req.user.id]);
    if (!(await checkPassword(current, user.password_hash))) throw badRequest("Current password is wrong");
    await query(`UPDATE users SET password_hash=$2 WHERE id=$1`, [req.user.id, await hashPassword(next)]);
    await query(`DELETE FROM sessions WHERE user_id=$1 AND id <> $2`, [req.user.id, req.sessionId]);
    res.json({ ok: true });
  })
);

r.post(
  "/accounts",
  requireAuth,
  ah(async (req, res) => {
    const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
    const account = await tx(async (c) => {
      const a = (await c.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [name])).rows[0];
      await c.query(`INSERT INTO memberships (user_id, account_id, role) VALUES ($1,$2,'owner')`, [req.user.id, a.id]);
      return a;
    });
    await query(`UPDATE sessions SET active_account_id=$2 WHERE id=$1`, [req.sessionId, account.id]);
    res.json({ id: account.id });
  })
);

export default r;
