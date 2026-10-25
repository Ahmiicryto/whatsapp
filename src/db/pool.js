import pg from "pg";
import { config } from "../config.js";
import { logger } from "../logger.js";

// numeric -> JS number (amounts here are well within float precision for display/aggregation)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// int8 -> number (ids and counts)
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: config.dbPoolMax,
  idleTimeoutMillis: config.serverless ? 5000 : 10000,
});

pool.on("error", (err) => logger.error({ err }, "postgres pool error"));

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function one(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows[0] ?? null;
}

export async function many(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
