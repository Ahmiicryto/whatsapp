import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import { ZodError } from "zod";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./db/pool.js";
import { HttpError, ah, forbidden } from "./lib/errors.js";
import { loadSession, requireAuth, createSession, destroySession } from "./api/auth.js";
import publicRoutes from "./api/public.js";
import authRoutes from "./api/routes/auth.js";
import storeRoutes from "./api/routes/stores.js";
import orderRoutes from "./api/routes/orders.js";
import inboxRoutes from "./api/routes/inbox.js";
import marketingRoutes from "./api/routes/marketing.js";
import templateRoutes from "./api/routes/templates.js";
import reportRoutes from "./api/routes/reports.js";
import teamRoutes from "./api/routes/team.js";
import adminRoutes from "./api/routes/admin.js";
import { isAuthorizedCron, runTick } from "./serverless.js";

const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "web");

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "blob:", "https:"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: "cross-origin" }, // Meta fetches our media/map URLs
    })
  );
  app.use(compression());
  app.use(cookieParser());
  app.use(
    express.json({
      limit: "8mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf; // raw bytes for HMAC checks
      },
    })
  );

  app.get("/healthz", ah(async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  }));

  // Serverless job runner: Vercel Cron (or any external cron) calls this every minute with CRON_SECRET.
  app.get("/api/cron/tick", ah(async (req, res) => {
    if (!isAuthorizedCron(req)) return res.status(401).json({ error: "unauthorized" });
    res.json(await runTick());
  }));

  app.use(loadSession);
  app.use(publicRoutes);

  // CSRF: cookies are SameSite=Lax and every state-changing API call must carry this header,
  // which cross-site forms can't set.
  app.use("/api", (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.get("X-Requested-With") !== "wa-portal") return next(forbidden("Missing CSRF header"));
    next();
  });
  app.use("/api/auth", authRoutes);
  app.post(
    "/api/auth/stop-impersonating",
    requireAuth,
    ah(async (req, res) => {
      if (!req.user.impersonatorId) throw forbidden("Not impersonating");
      const adminId = req.user.impersonatorId;
      await destroySession(req, res);
      await createSession(res, adminId);
      res.json({ ok: true });
    })
  );
  const api = express.Router();
  api.use(requireAuth);
  api.use(storeRoutes);
  api.use(orderRoutes);
  api.use(inboxRoutes);
  api.use(marketingRoutes);
  api.use(templateRoutes);
  api.use(reportRoutes);
  api.use(teamRoutes);
  api.use("/admin", adminRoutes);
  app.use("/api", api);
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "API route not found")));

  // React portal
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  } else {
    app.get("/", (_req, res) => res.send("API is running. Build the portal with `npm run build`."));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: "Invalid input", details: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    }
    const status = err.status || err.statusCode || 500;
    if (status >= 500) logger.error({ err, path: req.path }, "request failed");
    res.status(status).json({ error: status >= 500 && config.isProd ? "Something went wrong" : err.message, details: err.details });
  });
  return app;
}
