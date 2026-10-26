import bcrypt from "bcryptjs";
import { one, many, query } from "../db/pool.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { config } from "../config.js";
import { unauthorized, forbidden, notFound, badRequest } from "../lib/errors.js";

export const COOKIE = "wa_sid";
const SESSION_DAYS = 14;
export const ROLE_RANK = { viewer: 1, agent: 2, admin: 3, owner: 4 };

export async function hashPassword(pw) {
  if (!pw || String(pw).length < 8) throw badRequest("Password must be at least 8 characters");
  return bcrypt.hash(String(pw), 10);
}

export const checkPassword = (pw, hash) => bcrypt.compare(String(pw || ""), hash || "");

export async function createSession(res, userId, { impersonatorId = null, accountId = null } = {}) {
  const token = randomToken(32);
  await query(
    `INSERT INTO sessions (id, user_id, impersonator_id, active_account_id, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval)`,
    [sha256(token), userId, impersonatorId, accountId, String(SESSION_DAYS)]
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    maxAge: SESSION_DAYS * 86400000,
    path: "/",
  });
}

export async function destroySession(req, res) {
  const token = req.cookies?.[COOKIE];
  if (token) await query(`DELETE FROM sessions WHERE id=$1`, [sha256(token)]);
  res.clearCookie(COOKIE, { path: "/" });
}

/** Loads user, memberships and the active account into req. */
export async function loadSession(req, _res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) return next();
    const s = await one(
      `SELECT s.id AS session_id, s.impersonator_id, s.active_account_id, u.id, u.email, u.name, u.is_super_admin, u.status
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id=$1 AND s.expires_at > now()`,
      [sha256(token)]
    );
    if (!s || s.status !== "active") return next();
    req.sessionId = s.session_id;
    req.user = { id: s.id, email: s.email, name: s.name, isSuperAdmin: s.is_super_admin, impersonatorId: s.impersonator_id };
    req.memberships = await many(
      `SELECT m.account_id, m.role, m.store_ids, a.name AS account_name, a.status AS account_status
         FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.user_id=$1 ORDER BY a.id`,
      [s.id]
    );
    let accountId = s.active_account_id;
    if (!accountId || (!req.user.isSuperAdmin && !req.memberships.some((m) => m.account_id === accountId))) {
      accountId = req.memberships[0]?.account_id ?? null;
    }
    req.accountId = accountId;
    req.membership = req.memberships.find((m) => m.account_id === accountId) || null;
    if (!req.membership && req.user.isSuperAdmin && accountId) {
      req.membership = { account_id: accountId, role: "owner", store_ids: null, superAdminView: true };
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireSuperAdmin(req, _res, next) {
  if (!req.user?.isSuperAdmin) return next(forbidden("Super admin only"));
  next();
}

export const requireRole = (min) => (req, _res, next) => {
  if (req.user?.isSuperAdmin) return next();
  if (!req.membership) return next(forbidden("No account selected"));
  if (req.membership.account_status === "suspended") return next(forbidden("This account is suspended"));
  if ((ROLE_RANK[req.membership.role] || 0) < ROLE_RANK[min]) return next(forbidden(`Requires ${min} role`));
  next();
};

/** Store ids the user can see in the active account. */
export async function accessibleStoreIds(req) {
  if (!req.accountId) return [];
  const rows = await many(`SELECT id FROM stores WHERE account_id=$1 ORDER BY id`, [req.accountId]);
  const ids = rows.map((r) => r.id);
  const limit = req.membership?.store_ids;
  return limit && !req.user.isSuperAdmin ? ids.filter((id) => limit.map(Number).includes(id)) : ids;
}

/** ?storeId=all|<id> -> array of permitted store ids (throws on a store outside the user's access). */
export async function scopeStoreIds(req) {
  const ids = await accessibleStoreIds(req);
  const q = req.query.storeId;
  if (!q || q === "all") return ids;
  const id = Number(q);
  if (!ids.includes(id)) throw forbidden("You don't have access to this store");
  return [id];
}

/** Store row if the user may act on it with at least `min` role. */
export async function assertStore(req, storeId, min = "viewer") {
  const id = Number(storeId);
  if (!id) throw badRequest("storeId is required");
  const store = await one(`SELECT * FROM stores WHERE id=$1`, [id]);
  if (!store) throw notFound("Store not found");
  if (req.user.isSuperAdmin) return store;
  if (store.account_id !== req.accountId) throw forbidden("You don't have access to this store");
  const ids = await accessibleStoreIds(req);
  if (!ids.includes(id)) throw forbidden("You don't have access to this store");
  if ((ROLE_RANK[req.membership?.role] || 0) < ROLE_RANK[min]) throw forbidden(`Requires ${min} role`);
  return store;
}

/** Ensures the row (with store_id) belongs to an accessible store; returns it. */
export async function assertRow(req, table, id, min = "viewer") {
  const allowed = ["orders", "customers", "conversations", "campaigns", "segments", "templates", "messages", "shipments", "reviews", "products", "automation_rules", "store_couriers", "ad_spend"];
  if (!allowed.includes(table)) throw new Error("bad table");
  const row = await one(`SELECT * FROM ${table} WHERE id=$1`, [Number(id)]);
  if (!row) throw notFound();
  await assertStore(req, row.store_id, min);
  return row;
}
