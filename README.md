# WA Commerce: WhatsApp automation for Shopify

One platform that links many Shopify stores to WhatsApp and runs them on Render.

- **Order sync**: every new order lands in the portal, from Shopify webhooks plus a 15-minute reconciliation job that catches missed webhooks.
- **Rich confirmation message**: product image, products with quantities and prices, customer name, store name, customer mobile, delivery address and total, with **Confirm / Change address / Cancel** buttons.
- **Shopify tags**: `wa-sent`, `wa-confirmed`, `wa-cancelled`, `wa-no-response`, `address-verified`, `address-updated`, `wa-tracking-sent`, `risk-high`… Every tag name can be changed per store.
- **Address verification**: Google Address Validation or Geocoding plus AI score each address. Weak ones are confirmed with the customer on WhatsApp, who can share a **location pin** or type a new address (AI turns it into structured fields). The fixed address is written back to Shopify.
- **Tracking**: shipped (with a tracked link button), out for delivery and delivered messages, plus optional review requests.
- **Marketing**: opt-in and opt-out handling (STOP), RFM segments, a segment builder, campaigns with A/B tests, unique Shopify discount codes, click tracking and revenue attribution, abandoned-cart recovery, win-back, and a COD-to-prepaid offer.
- **AI (OpenAI / ChatGPT, optional Gemini)**:
  - understands replies in any language, including Roman Urdu
  - transcribes voice notes
  - a support agent that hands over to a human when needed
  - address parsing
  - template and campaign copywriting
  - fake-order risk review
  - a summary in each report
  - "Ask your data" questions about your numbers
- **Owner reports**: daily, weekly and monthly PDF reports with charts, sent to owner WhatsApp numbers, plus instant alerts (high value order, high risk, failed-message spike, number quality drop).
- **Multiple stores per user**: each store has its own Shopify connection, WhatsApp number, templates, settings, AI keys and reports. Users get roles (owner, admin, agent, viewer), optionally limited to specific stores.
- **Super admin**: sees every account, store, order, message and job; can suspend accounts, open any account, and impersonate a user (every impersonation is logged).
- **Portal**: dashboards with charts, orders, a shared WhatsApp inbox, customers, marketing, a template builder that submits to Meta, automations, reports, stores, team, and an audit log.

## Architecture

```
Shopify ──webhooks──▶  web service (Express)  ──▶ Postgres ◀── worker (jobs + cron)
Meta    ──webhooks──▶  /webhooks/*  → verify → queue        │
Portal (React)  ◀──▶  /api/*                                └─▶ Shopify GraphQL · WhatsApp Cloud API · Google · OpenAI
```

- `src/`: Node 20+ (ESM). Express API, webhooks, and a job queue on Postgres (`FOR UPDATE SKIP LOCKED`, retries, delays, cron). No Redis needed.
- `web/`: React + Vite + Tailwind + Recharts portal, built into `dist/web` and served by the web service.
- Secrets (Shopify tokens, WhatsApp tokens, store API keys) are stored encrypted with AES-256-GCM using `ENCRYPTION_KEY`.

## Deploy on Vercel

Vercel runs the app as one serverless function (`api/index.js`) plus the static portal. With no always-on worker, background jobs run in two ways:
- **Right after a webhook or action**, in the same function call. A new order's confirmation goes out within seconds.
- **Every minute, from a scheduler** calling `/api/cron/tick`. This handles delayed work: reminders, no-response timeouts, campaigns, reports, retries and order reconciliation.

Steps:
1. **Create a Postgres database.** In your Vercel project open **Storage → Create Database → Neon** (free tier available) and connect it to the project. Vercel then adds `DATABASE_URL` (or `POSTGRES_URL`) for you; either works. If you use Supabase or Neon directly instead, copy the **pooled** connection string into `DATABASE_URL`. Also set `DATABASE_SSL=true`. You don't need to create tables: they're created automatically on the first request.
2. **Import the repo** in Vercel (Add New → Project). Leave the framework preset as "Other"; `vercel.json` sets the install and build commands, output folder, function, rewrites and cron.
3. **Add environment variables** (Project → Settings → Environment Variables):
   - `DATABASE_URL`, `DATABASE_SSL=true`. Don't set `NODE_ENV`: Vercel sets it at runtime.
   - `SESSION_SECRET` and `ENCRYPTION_KEY`: generate each with `openssl rand -base64 32`. Never change `ENCRYPTION_KEY` once data exists.
   - `CRON_SECRET`: any long random string. The tick endpoint rejects calls without it.
   - `APP_BASE_URL`: your production domain, e.g. `https://wa-commerce.vercel.app`. If omitted, Vercel's production URL is used.
   - `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`, `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_MAPS_API_KEY`, and optionally `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`. These are the same as `.env.example`.
4. **Deploy.** Migrations run on the first request. Open `/healthz` to check the database connection.
5. **Turn on the every-minute scheduler.** `vercel.json` ships with a once-a-day cron so the deploy works on every plan, including Hobby. Pick one:
   - **Free (any plan):** create a job at cron-job.org (or any uptime/cron service) that calls `https://YOUR-DOMAIN/api/cron/tick` every minute, with the header `Authorization: Bearer <CRON_SECRET>`.
   - **Vercel Pro:** change the schedule in `vercel.json` to `"* * * * *"` and redeploy. Vercel then sends the secret itself.

Note: Vercel's Hobby plan is for non-commercial use. Use Pro for a live business.

## Deploy on Render

1. Push this repo to GitHub. In Render, go to **New → Blueprint** and select the repo. `render.yaml` creates:
   - `wa-commerce-web`: API, portal and webhooks
   - `wa-commerce-worker`: background jobs and schedules
   - `wa-commerce-db`: Postgres
2. Open the **wa-commerce-shared** env group and fill in:
   - `APP_BASE_URL`: the web service URL, e.g. `https://wa-commerce-web.onrender.com`
   - `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`: your super admin login, created on first boot
   - `META_APP_ID`, `META_APP_SECRET`: from your Meta app
   - `OPENAI_API_KEY`, and `GOOGLE_MAPS_API_KEY`: needed for AI and address checks
   - `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`: optional, enables one-click install
3. Redeploy. Migrations run automatically on boot.

**Cheaper single-service option:** delete the worker from `render.yaml` and set `RUN_WORKER_IN_PROCESS=true` on the web service.

Don't use free instances. They sleep, so webhooks arrive late and reminders and reports don't run on time. Free Postgres databases also expire.

## Setup per store (in the portal)

1. **Stores → Connect store**. Either:
   - **Install app (OAuth)**: needs `SHOPIFY_API_KEY`/`SECRET`, a Shopify app created in the Shopify Dev Dashboard with redirect URL `APP_BASE_URL/shopify/callback`, and compliance webhooks pointed at `APP_BASE_URL/webhooks/shopify/compliance`.
   - **Custom app token**: paste the store's Admin API token (`shpat_…`) and the app's API secret key. Required scopes:
     `read_orders, write_orders, read_customers, write_customers, read_products, read_fulfillments, read_checkouts, write_discounts, write_order_edits`.
   - In the app, request **protected customer data** access for name, phone, email and address. Without it, webhooks arrive with no phone number.
   - In Shopify checkout settings, make the phone number required.
   - The platform registers webhooks itself and imports the last 30 days of orders.
2. **Store → WhatsApp**: enter the Phone number ID, the WhatsApp Business Account ID and a permanent System User token from Meta Business Settings.
   - In your Meta app's WhatsApp configuration, set the webhook to the URL and verify token shown on that page.
   - Subscribe to the `messages`, `message_template_status_update` and `phone_number_quality_update` fields.
   - The default templates are submitted to Meta automatically. Approval usually takes minutes to hours; check **Templates**.
3. **Reports → Add owner number**: choose which reports and alerts each number receives.
4. **Automations**: choose which orders get confirmations, reminder timings, address thresholds, tracking messages, abandoned carts, win-back, quiet hours and alerts.
5. **Store → AI & keys**: knowledge base for the AI agent, tone, provider, and optional per-store OpenAI, Gemini or Google keys.

## Local development

```bash
cp .env.example .env            # set DATABASE_URL; export the variables or use a dotenv loader
npm install
npm run dev                     # API on :3000 (runs migrations, seeds super admin)
npm run dev:web                 # portal on :5173 (proxies /api)
DATABASE_URL=... npm run seed:demo   # demo data, login demo@example.com / demopassword
npm test                        # unit + end-to-end flow tests (needs Postgres, see test/env.js)
```

Tests mock Shopify, Meta, Google and OpenAI, and cover the full flows:
- order to confirmation, then confirm, cancel, address change and tracking
- tags, campaigns and abandoned carts
- reports and alerts
- AI intent, agent and address parsing
- tenant isolation and super admin access
- webhook signatures and CSRF protection

## Message flow

| Event | What happens |
|---|---|
| `orders/create` | Product images fetched, bundle split (optional), address scored, risk scored, alerts raised. Then, for eligible orders (cash on delivery by default), the `order_confirmation` template is sent and the order tagged `wa-sent`. A reminder and a no-response timeout are scheduled. |
| Customer taps **Confirm** | Status set to confirmed and tags updated. If the address is weak, a map preview with "is this correct?" is sent. Otherwise a thank-you with an offer to opt in to marketing. |
| **Change address** | The customer is asked for a location pin or a typed address. AI parses it, the customer confirms, and the address is written back to the Shopify order and tagged `address-updated`. |
| **Cancel** | The customer picks a reason from a list. The order is tagged `wa-cancelled`, and optionally cancelled in Shopify. |
| Free text or voice note | AI works out the intent (confirm, cancel, address, tracking, question, opt-out). The AI agent answers or flags the chat for a human in the inbox. |
| `fulfillments/*` | Shipped message with a tracked link, then out-for-delivery and delivered messages, plus an optional review request. |
| `checkouts/*` | Abandoned cart steps (opted-in shoppers only), each with an optional unique discount code. |
| Cron | Reconciliation every 15 minutes, owner reports at the configured local time, campaign scheduling, RFM segments and win-back daily, alerts hourly. |
