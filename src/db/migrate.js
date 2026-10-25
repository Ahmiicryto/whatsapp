import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";
import { logger } from "../logger.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate() {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    // Everything runs in ONE transaction with a transaction-scoped lock, so it is safe through
    // PgBouncer-style poolers (Neon / Supabase pooled URLs) and when several instances boot at once.
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(727001)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    );
    const applied = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (applied.has(file)) continue;
      logger.info({ file }, "applying migration");
      await client.query(await fs.readFile(path.join(dir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => {
      logger.info("migrations complete");
      return pool.end();
    })
    .catch((err) => {
      logger.error({ err }, "migration failed");
      process.exit(1);
    });
}
