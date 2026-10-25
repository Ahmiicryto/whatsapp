import { config } from "./config.js";
import { logger } from "./logger.js";
import { createApp } from "./app.js";
import { bootstrap } from "./bootstrap.js";
import { Worker, Cron } from "./queue/queue.js";
import { handlers, cronEntries } from "./jobs/index.js";

await bootstrap();

const app = createApp();
const server = app.listen(config.port, () => logger.info({ port: config.port, baseUrl: config.baseUrl }, "web server listening"));

// Small deployments can run jobs inside the web service (one Render service instead of two).
let worker;
let cron;
if (config.runWorkerInProcess) {
  worker = new Worker(handlers, { concurrency: 4 });
  cron = new Cron(cronEntries);
  worker.start();
  cron.start();
  logger.info("worker running in-process");
}

function shutdown() {
  logger.info("shutting down");
  worker?.stop();
  cron?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
