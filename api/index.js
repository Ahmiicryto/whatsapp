// Vercel entry point: every API, webhook, short-link and media request is rewritten here (see vercel.json).
import { createApp } from "../src/app.js";
import { bootstrap } from "../src/bootstrap.js";

const app = createApp();
let ready = null;
const MAX_BODY = 8 * 1024 * 1024;

/**
 * Read the raw request bytes ourselves before Express runs. Shopify/Meta webhook signatures are
 * computed over the exact bytes, and this works whether or not Vercel's request helpers are enabled.
 */
async function captureBody(req, res) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.rawBody) return true;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.statusCode = 413;
      res.end("Payload too large");
      return false;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  let parsed = {};
  if (raw.length && /json/i.test(String(req.headers["content-type"] || ""))) {
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return false;
    }
  }
  req.rawBody = raw;
  Object.defineProperty(req, "body", { value: parsed, writable: true, configurable: true, enumerable: true });
  req._body = true; // tells express.json() the body is already parsed
  return true;
}

export default async function handler(req, res) {
  // Migrations + super admin seed, once per cold start (guarded by a Postgres advisory lock).
  if (!ready) {
    ready = bootstrap().catch((err) => {
      ready = null;
      throw err;
    });
  }
  await ready;
  if (!(await captureBody(req, res))) return;
  return app(req, res);
}
