import { query, many } from "../db/pool.js";
import { logger } from "../logger.js";
import { sleep } from "../lib/http.js";

/**
 * Minimal durable job queue on Postgres (FOR UPDATE SKIP LOCKED).
 * - singletonKey: at most one queued/running job per key (dedupes reminders, cron, per-order work)
 * - handlers may throw PermanentError (no retry) or Reschedule (run later, attempt not counted)
 */
const listeners = [];

/** Called with the run time of every newly queued job (serverless uses it to process jobs right away). */
export function onEnqueue(fn) {
  listeners.push(fn);
}

export async function enqueue(name, data = {}, opts = {}) {
  const id = await insertJob(name, data, opts);
  if (id) {
    const runAt = opts.runAt ? new Date(opts.runAt) : new Date(Date.now() + (opts.delayMs || 0));
    for (const fn of listeners) fn(runAt);
  }
  return id;
}

async function insertJob(name, data, opts) {
  const runAt = opts.runAt ? new Date(opts.runAt) : new Date(Date.now() + (opts.delayMs || 0));
  const { rows } = await query(
    `INSERT INTO jobs (name, data, run_at, max_attempts, singleton_key, store_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (singleton_key) WHERE status IN ('queued','running') DO NOTHING
     RETURNING id`,
    [name, data, runAt, opts.maxAttempts ?? 5, opts.singletonKey ?? null, data.storeId ?? opts.storeId ?? null]
  );
  return rows[0]?.id ?? null;
}

export async function cancelJobs(singletonKeyPrefix) {
  await query(`UPDATE jobs SET status='done', last_error='cancelled', updated_at=now()
               WHERE status='queued' AND singleton_key LIKE $1`, [`${singletonKeyPrefix}%`]);
}

function backoffMs(attempt) {
  return Math.min(60 * 60 * 1000, 15000 * 2 ** (attempt - 1)); // 15s, 30s, 1m, 2m ... max 1h
}

export class Worker {
  constructor(handlers, { concurrency = 5, pollMs = 1000 } = {}) {
    this.handlers = handlers;
    this.concurrency = concurrency;
    this.pollMs = pollMs;
    this.running = false;
    this.active = 0;
  }

  async claim(limit) {
    return many(
      `UPDATE jobs SET status='running', locked_at=now(), attempts=attempts+1, updated_at=now()
       WHERE id IN (
         SELECT id FROM jobs WHERE status='queued' AND run_at <= now()
         ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
      [limit]
    );
  }

  async runJob(job) {
    const handler = this.handlers[job.name];
    const log = logger.child({ job: job.name, jobId: job.id });
    if (!handler) {
      await query(`UPDATE jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1`, [job.id, "no handler"]);
      return;
    }
    try {
      await handler(job.data, job);
      await query(`UPDATE jobs SET status='done', updated_at=now(), last_error=NULL WHERE id=$1`, [job.id]);
    } catch (err) {
      if (err.runAt) {
        await query(
          `UPDATE jobs SET status='queued', run_at=$2, attempts=attempts-1, last_error=$3, updated_at=now() WHERE id=$1`,
          [job.id, err.runAt, err.message]
        );
        return;
      }
      const final = err.permanent || job.attempts >= job.max_attempts;
      log[final ? "error" : "warn"]({ err: err.message, attempts: job.attempts }, "job failed");
      await query(
        `UPDATE jobs SET status=$2, run_at=$3, last_error=$4, updated_at=now() WHERE id=$1`,
        [job.id, final ? "failed" : "queued", new Date(Date.now() + backoffMs(job.attempts)), String(err.message).slice(0, 2000)]
      );
    }
  }

  /** Process everything that is due right now (used by tests and by the loop). */
  async drain(maxRounds = 50) {
    for (let i = 0; i < maxRounds; i++) {
      const jobs = await this.claim(this.concurrency);
      if (!jobs.length) return;
      await Promise.all(jobs.map((j) => this.runJob(j)));
    }
  }

  /**
   * Process due jobs until `deadline` (ms timestamp) or until nothing is due.
   * Used on serverless where a function only lives for a bounded time.
   * New jobs are only claimed while at least `reserveMs` remain, so running jobs can finish.
   */
  async drainUntil(deadline, { reserveMs = 12000 } = {}) {
    let processed = 0;
    while (Date.now() < deadline - reserveMs) {
      const jobs = await this.claim(this.concurrency);
      if (!jobs.length) break;
      await Promise.all(jobs.map((j) => this.runJob(j)));
      processed += jobs.length;
    }
    return processed;
  }

  async start() {
    this.running = true;
    logger.info({ concurrency: this.concurrency }, "worker started");
    while (this.running) {
      try {
        const free = this.concurrency - this.active;
        const jobs = free > 0 ? await this.claim(free) : [];
        for (const job of jobs) {
          this.active++;
          this.runJob(job).finally(() => this.active--);
        }
        if (!jobs.length) await sleep(this.pollMs);
      } catch (err) {
        logger.error({ err }, "worker loop error");
        await sleep(5000);
      }
    }
  }

  stop() {
    this.running = false;
  }
}

/**
 * Cron: every minute, each entry whose schedule matches enqueues its job exactly once per slot
 * (cron_runs PK makes it safe with several worker instances).
 * entry: { name, job, everyMinutes } | { name, job, atMinute } (hourly at minute)
 */
export class Cron {
  constructor(entries) {
    this.entries = entries;
    this.timer = null;
  }

  /**
   * Each entry runs once per period, on the first tick inside that period. Ticks that arrive
   * late or get skipped (serverless cron) therefore never lose a run.
   */
  async tick(now = new Date()) {
    const epochMinutes = Math.floor(now.getTime() / 60000);
    for (const e of this.entries) {
      let slot;
      if (e.everyMinutes) slot = `p${Math.floor(epochMinutes / e.everyMinutes)}`;
      else if (now.getUTCMinutes() >= (e.atMinute ?? 0)) slot = now.toISOString().slice(0, 13);
      else continue;
      const { rowCount } = await query(
        `INSERT INTO cron_runs (name, slot) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [e.name, slot]
      );
      if (rowCount) await enqueue(e.job, e.data || {}, { singletonKey: `cron:${e.name}`, maxAttempts: 1 });
    }
  }

  start() {
    const loop = async () => {
      try {
        await this.tick();
      } catch (err) {
        logger.error({ err }, "cron tick failed");
      }
      const msToNextMinute = 60000 - (Date.now() % 60000) + 50;
      this.timer = setTimeout(loop, msToNextMinute);
    };
    loop();
  }

  stop() {
    clearTimeout(this.timer);
  }
}
