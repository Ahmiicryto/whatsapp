import { z } from "zod";

const bool = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_BASE_URL: z.string().optional(),
  RENDER_EXTERNAL_URL: z.string().optional(),
  VERCEL: z.string().optional(),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().optional(),
  DATABASE_URL: z.string().optional(),
  POSTGRES_URL: z.string().optional(), // name used by some Vercel storage integrations
  DATABASE_SSL: bool(false),
  SESSION_SECRET: z.string().default("dev-session-secret-change-me"),
  ENCRYPTION_KEY: z.string().optional(),
  RUN_WORKER_IN_PROCESS: bool(false),
  ALLOW_SIGNUP: bool(true),

  SUPER_ADMIN_EMAIL: z.string().optional(),
  SUPER_ADMIN_PASSWORD: z.string().optional(),
  SUPER_ADMIN_RESET_PASSWORD: bool(false),

  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  SHOPIFY_SCOPES: z
    .string()
    .default(
      "read_orders,write_orders,read_customers,write_customers,read_products,read_fulfillments,read_checkouts,write_discounts,read_locations,write_order_edits"
    ),
  SHOPIFY_API_VERSION: z.string().default("2025-10"),

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().default("change-me-verify-token"),
  META_GRAPH_VERSION: z.string().default("v23.0"),
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().optional(),
  GATEWAY_URL: z.string().optional(),
  GATEWAY_SECRET: z.string().optional(),
  PLATFORM_REPORT_PHONE: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),
  OPENAI_TRANSCRIBE_MODEL: z.string().default("whisper-1"),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),

  GOOGLE_MAPS_API_KEY: z.string().optional(),

  DEFAULT_COUNTRY: z.string().default("PK"),
  DEFAULT_TIMEZONE: z.string().default("Asia/Karachi"),
  DEFAULT_CURRENCY: z.string().default("PKR"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test",
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  baseUrl: (
    env.APP_BASE_URL ||
    env.RENDER_EXTERNAL_URL ||
    (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null) ||
    `http://localhost:${env.PORT}`
  ).replace(/\/$/, ""),
  serverless: !!env.VERCEL,
  cronSecret: env.CRON_SECRET,
  dbPoolMax: env.DB_POOL_MAX ?? (env.VERCEL ? 3 : 10),
  databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || "postgres://localhost:5432/wa_commerce",
  databaseSsl: env.DATABASE_SSL,
  sessionSecret: env.SESSION_SECRET,
  encryptionKey: env.ENCRYPTION_KEY,
  runWorkerInProcess: env.RUN_WORKER_IN_PROCESS,
  allowSignup: env.ALLOW_SIGNUP,
  superAdmin: { email: env.SUPER_ADMIN_EMAIL, password: env.SUPER_ADMIN_PASSWORD, resetPassword: env.SUPER_ADMIN_RESET_PASSWORD },
  shopify: {
    apiKey: env.SHOPIFY_API_KEY,
    apiSecret: env.SHOPIFY_API_SECRET,
    scopes: env.SHOPIFY_SCOPES,
    apiVersion: env.SHOPIFY_API_VERSION,
  },
  meta: {
    appId: env.META_APP_ID,
    appSecret: env.META_APP_SECRET,
    verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
    graphVersion: env.META_GRAPH_VERSION,
    embeddedSignupConfigId: env.META_EMBEDDED_SIGNUP_CONFIG_ID,
  },
  openai: {
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    transcribeModel: env.OPENAI_TRANSCRIBE_MODEL,
    baseUrl: env.OPENAI_BASE_URL.replace(/\/$/, ""),
  },
  gemini: { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL },
  google: { mapsKey: env.GOOGLE_MAPS_API_KEY },
  gateway: { url: env.GATEWAY_URL?.replace(/\/$/, ""), secret: env.GATEWAY_SECRET },
  platformReportPhone: env.PLATFORM_REPORT_PHONE,
  defaults: {
    country: env.DEFAULT_COUNTRY,
    timezone: env.DEFAULT_TIMEZONE,
    currency: env.DEFAULT_CURRENCY,
  },
};

/** Required production settings that are missing (shown on every request on serverless instead of crashing). */
config.missingEnv = [];
if (config.isProd) {
  if (!config.encryptionKey) config.missingEnv.push("ENCRYPTION_KEY");
  if (config.sessionSecret === "dev-session-secret-change-me") config.missingEnv.push("SESSION_SECRET");
  if (!env.DATABASE_URL && !env.POSTGRES_URL) config.missingEnv.push("DATABASE_URL");
  if (config.missingEnv.length) {
    console.error(`Missing required production env vars: ${config.missingEnv.join(", ")}`);
    if (!config.serverless) process.exit(1);
  }
}
