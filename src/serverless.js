import { waitUntil } from "@vercel/functions";
import { Worker, Cron, onEnqueue } from "./queue/queue.js";
import { handlers, cronEntries } from "./jobs/index.js";
import { safeEqual } from "./lib/crypto.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Serverless (Vercel) has no always-on worker. Jobs run in two ways instead:
 * 1. right after a request queues work, inside the same invocation via waitUntil()
 *    (so a new order's WhatsApp confirmation goes out within seconds);
 * 2. a cron request every minute (/api/cron/tick) that queues scheduled work and drains
 *    delayed jobs (reminders, campaigns, reports, retries).
 */
export const worker = new Worker(handlers, { concurrency: 4 });
const cron = new Cron(cronEntries);

const AFTER_RESPONSE_BUDGET_MS = 25000;
const TICK_BUDGET_MS = 50000; // stays inside the 60s function limit set in vercel.json

let draining = null;

function kick() {
  if (draining) return;
  draining = worker
    .drainUntil(Date.now() + AFTER_RESPONSE_BUDGET_MS, { reserveMs: 5000 })
    .catch((err) => logger.error({ err }, "post-response drain failed"))
    .finally(() => {
      draining = null;
    });
  waitUntil(draining); // keeps the function alive after the response (no-op outside Vercel)
}

if (config.serverless) {
  // Only jobs due now are worth draining immediately; delayed ones are picked up by the cron tick.
  onEnqueue((runAt) => {
    if (runAt.getTime() <= Date.now() + 2000) kick();
  });
}

export function isAuthorizedCron(req) {
  if (!config.cronSecret) return false;
  const header = String(req.get("authorization") || "");
  return safeEqual(header, `Bearer ${config.cronSecret}`);
}

export async function runTick() {
  const started = Date.now();
  await cron.tick(new Date());
  const processed = await worker.drainUntil(started + TICK_BUDGET_MS);
  return { processed, ms: Date.now() - started };
}
