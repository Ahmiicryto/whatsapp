import { one, query } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { hashPassword } from "./api/auth.js";

/**
 * Runs migrations and seeds the super admin from env. The password is only set on first creation,
 * unless SUPER_ADMIN_RESET_PASSWORD=true (use once to recover access, then remove it).
 */
export async function bootstrap() {
  await migrate();
  const { email, password } = config.superAdmin;
  if (email && password) {
    const existing = await one(`SELECT id, is_super_admin FROM users WHERE email=$1`, [email.toLowerCase()]);
    if (!existing) {
      await query(`INSERT INTO users (email, password_hash, name, is_super_admin) VALUES ($1,$2,'Super Admin',true)`, [email.toLowerCase(), await hashPassword(password)]);
      logger.info({ email }, "super admin created");
    } else {
      if (!existing.is_super_admin) await query(`UPDATE users SET is_super_admin=true WHERE id=$1`, [existing.id]);
      if (config.superAdmin.resetPassword) {
        await query(`UPDATE users SET password_hash=$2, status='active' WHERE id=$1`, [existing.id, await hashPassword(password)]);
        await query(`DELETE FROM sessions WHERE user_id=$1`, [existing.id]);
        logger.warn({ email }, "super admin password reset from env; remove SUPER_ADMIN_RESET_PASSWORD");
      }
    }
  }
}
