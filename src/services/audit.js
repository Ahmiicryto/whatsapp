import { query } from "../db/pool.js";
import { monthKey } from "../lib/time.js";
import { logger } from "../logger.js";

export async function audit({ user, accountId, storeId, action, target, details }) {
  try {
    await query(
      `INSERT INTO audit_logs (actor_user_id, impersonator_id, account_id, store_id, action, target, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [user?.id ?? null, user?.impersonatorId ?? null, accountId ?? null, storeId ?? null, action, target ?? null, details == null ? null : JSON.stringify(details)]
    );
  } catch (err) {
    logger.warn({ err: err.message, action }, "audit log failed");
  }
}

export async function countUsage(accountId, field, n = 1) {
  if (!accountId) return;
  const allowed = ["messages", "marketing_messages", "ai_tokens", "address_checks"];
  if (!allowed.includes(field)) throw new Error(`unknown usage field ${field}`);
  await query(
    `INSERT INTO usage_counters (account_id, month, ${field}) VALUES ($1,$2,$3)
     ON CONFLICT (account_id, month) DO UPDATE SET ${field} = usage_counters.${field} + EXCLUDED.${field}`,
    [accountId, monthKey(), n]
  );
}
