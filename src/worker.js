import { logger } from "./logger.js";
import { bootstrap } from "./bootstrap.js";
import { Worker, Cron } from "./queue/queue.js";
import { handlers, cronEntries } from "./jobs/index.js";

await bootstrap();

const worker = new Worker(handlers, { concurrency: Number(process.env.WORKER_CONCURRENCY || 8) });
const cron = new Cron(cronEntries);
worker.start();
cron.start();
logger.info("background worker started");

function shutdown() {
  logger.info("worker shutting down");
  worker.stop();
  cron.stop();
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
