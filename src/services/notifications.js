import { one, many, query } from "../db/pool.js";
import { logger } from "../logger.js";
import { enqueue } from "../queue/queue.js";

/**
 * In-app notification for the bell menu. `userId` targets one person; otherwise everyone in the account
 * (or, with no account, the super admins) sees it. Also fans out to outgoing webhooks as "notification.created".
 */
export async function notify({ accountId = null, storeId = null, userId = null, kind, title, body = null, link = null, severity = "info" }) {
  try {
    const row = await one(
      `INSERT INTO notifications (account_id, store_id, user_id, kind, severity, title, body, link)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [accountId, storeId, userId, kind, severity, String(title).slice(0, 200), body ? String(body).slice(0, 1000) : null, link]
    );
    if (accountId) await enqueue("webhooks.emit", { accountId, event: "notification.created", data: row }).catch(() => {});
    return row;
  } catch (err) {
    logger.warn({ err: err.message, kind }, "notification insert failed");
    return null;
  }
}

/** Notifications visible to a user in the active account (super admins also see platform ones). */
function visibleWhere(params, { userId, accountId, isSuperAdmin, storeIds }) {
  params.push(userId, accountId, storeIds);
  const u = params.length - 2;
  let where = `((n.account_id = $${u + 1} AND (n.user_id IS NULL OR n.user_id = $${u}) AND (n.store_id IS NULL OR n.store_id = ANY($${u + 2})))`;
  where += ` OR (n.user_id = $${u} AND n.account_id IS NULL)`;
  if (isSuperAdmin) where += ` OR (n.account_id IS NULL AND n.user_id IS NULL)`;
  return `${where})`;
}

export async function listNotifications(ctx, { limit = 40, unreadOnly = false } = {}) {
  const params = [];
  const where = visibleWhere(params, ctx);
  params.push(ctx.userId);
  const me = params.length;
  const rows = await many(
    `SELECT n.*, ($${me} = ANY(n.read_by)) AS read FROM notifications n
      WHERE ${where} ${unreadOnly ? `AND NOT ($${me} = ANY(n.read_by))` : ""}
      ORDER BY n.created_at DESC LIMIT ${Math.min(100, Number(limit) || 40)}`,
    params
  );
  const unread = await one(
    `SELECT count(*)::int AS n FROM notifications n WHERE ${where} AND NOT ($${me} = ANY(n.read_by)) AND n.created_at > now() - interval '30 days'`,
    params
  );
  return { rows: rows.map(({ read_by: _r, ...n }) => n), unread: unread.n };
}

export async function markRead(ctx, ids) {
  const params = [];
  const where = visibleWhere(params, ctx);
  params.push(ctx.userId);
  const me = params.length;
  let extra = "";
  if (ids?.length) {
    params.push(ids.map(Number));
    extra = ` AND n.id = ANY($${params.length})`;
  }
  await query(`UPDATE notifications n SET read_by = array_append(read_by, $${me}) WHERE ${where}${extra} AND NOT ($${me} = ANY(read_by))`, params);
}

export async function pruneNotifications() {
  await query(`DELETE FROM notifications WHERE created_at < now() - interval '90 days'`);
}
