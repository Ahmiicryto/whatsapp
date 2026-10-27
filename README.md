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
- **WhatsApp connection, three ways**: **Connect with Facebook** (Meta's official Embedded Signup, including the "keep using the WhatsApp Business app" QR coexistence flow), **Scan QR code** (WhatsApp Web style through the optional gateway service; unofficial), or paste Cloud API details by hand.
- **Product catalog with photos**: products, variant images, prices and stock are imported from Shopify and kept in sync by webhooks. Confirmation messages use the exact variant photo.
- **Personal daily report**: every user can add their WhatsApp number under **My profile** and get one daily PDF covering all their stores. The super admin gets a daily **platform report** covering every business.
- **Couriers & COD**:
  - PostEx, Leopards and Trax built in; any other courier with an API (TCS, M&P, Call Courier…) or a manual courier.
  - One-click, bulk or automatic booking, with Shopify fulfillment and tracking sync.
  - Failed-delivery recovery on WhatsApp.
  - COD reconciliation with courier CSV import.
- **Fraud protection**:
  - Each number's delivery record across every store on the platform.
  - Blocklist, with automatic blocking after repeated returns.
  - Advance payments by wallet/bank, or a Stripe card link.
- **Profit**: real profit after product cost, courier fees, returns, COD fees, packaging and ad spend.
- **Growth**:
  - Upsell after confirmation (added to the Shopify order).
  - Photo reviews on WhatsApp with a public JSON feed.
  - Back-in-stock alerts.
  - AI product recommendations with one-tap buy links.
  - Click-to-WhatsApp ad attribution.
- **Automation rules**: IF trigger + conditions THEN steps (tag, message, notify, assign, book courier, ask advance, wait…).
- **Team inbox**: assignment, labels, internal notes with @mentions, saved replies (type `/`), product cards.
- **Notifications, search, help**: in-app bell with desktop alerts, Ctrl/⌘ K global search, and a "How to use" guide on every page plus a Help center.
- **SaaS billing**: plans with limits, a free trial, Stripe subscriptions or manual bank/JazzCash activation.
- **Developers**: REST API (`/v1`, bearer tokens) and signed outgoing webhooks.
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

## Deploy anywhere

See **[docs/DEPLOY.md](docs/DEPLOY.md)** for every kind of hosting:
- VPS with Docker Compose (Postgres, worker, QR gateway and automatic HTTPS included), or PM2 + Nginx.
- Render, Railway, Fly.io, Heroku.
- Coolify, Dokploy.
- cPanel/Hostinger Node.js.
- Cloud Run / App Runner.
- Vercel and other serverless hosts.

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

## Admin login

- The **super admin** is created automatically on first startup from `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`. Sign in at `https://YOUR-DOMAIN/login`; a **Super admin** item appears at the bottom of the menu.
- Changing `SUPER_ADMIN_PASSWORD` later does **not** change the password. To reset it: set the new password, add `SUPER_ADMIN_RESET_PASSWORD=true`, redeploy, open the site once, then **remove** `SUPER_ADMIN_RESET_PASSWORD` and redeploy again.
- Store owners create their own accounts with **Create an account** on the login page (turn this off with `ALLOW_SIGNUP=false`). Owners add their team under **Team & logs**.

## Setup per store (in the portal)

1. **Connect Shopify (one-time app setup, then one click per store).**
   - In the **Shopify Dev Dashboard** (dev.shopify.com), create an app and set:
     - **App URL:** `https://YOUR-DOMAIN/shopify/install`
     - **Redirect URL:** `https://YOUR-DOMAIN/shopify/callback`
     - **Scopes:** `read_orders,write_orders,read_customers,write_customers,read_products,read_fulfillments,read_checkouts,write_discounts,read_locations,write_order_edits`
     - **Optional extra scopes:** `read_inventory` (product costs for the Profit page) and `write_merchant_managed_fulfillment_orders` (mark orders fulfilled in Shopify when a courier is booked). Add them to the app's scopes **first**, release a new version, then set `SHOPIFY_SCOPES` to the full list. If the app requests a scope it doesn't have, Shopify refuses the install.
     - **Embed app in Shopify admin:** off is simplest (on also works).
     - Request **protected customer data** access for name, email, phone and address.
   - Put the app's **Client ID** in `SHOPIFY_API_KEY` and its **Client secret** in `SHOPIFY_API_SECRET`, then redeploy.
   - **Linking a store** works in any of these ways:
     - Click the app's install link from the Dev Dashboard (Distribution).
     - Open `https://YOUR-DOMAIN/install`.
     - Use **Stores → Connect store** in the portal.

     After the merchant approves in Shopify, the store links itself: to the signed-in account, to its previous account on a reinstall, or through a one-click "Link your store" page after signing in or signing up. Webhooks are registered and the last 30 days of orders imported automatically.
   - **Older stores:** if the store has a legacy custom app with an Admin token (`shpat_…`), use the **Custom app token** tab instead.
   - In Shopify checkout settings, make the phone number required.
2. **Store → WhatsApp**: pick one of the three ways to connect (see [Connecting WhatsApp](#connecting-whatsapp)). For **Enter API details**: the Phone number ID, the WhatsApp Business Account ID and a permanent System User token from Meta Business Settings.
   - In your Meta app's WhatsApp configuration, set the webhook to the URL and verify token shown on that page.
   - Subscribe to the `messages`, `message_template_status_update` and `phone_number_quality_update` fields.
   - The default templates are submitted to Meta automatically. Approval usually takes minutes to hours; check **Templates**.
3. **My profile**: add your WhatsApp number and turn on **Send me the daily report**, which covers all your stores. Use **Reports → Add owner number** for extra numbers, or for a report about a single store.
4. **Automations**: choose which orders get confirmations, reminder timings, address thresholds, tracking messages, abandoned carts, win-back, quiet hours and alerts.
5. **Store → AI & keys**: knowledge base for the AI agent, tone, provider, and optional per-store OpenAI, Gemini or Google keys.

## Connecting WhatsApp

**1. Connect with Facebook (official, recommended).** The merchant signs in with Facebook in a popup, picks or creates the WhatsApp Business account and number, and the store is linked; no tokens are copied by hand. With **Keep using the WhatsApp Business app** on, Meta shows a QR code that the merchant scans with the WhatsApp Business app, so chats stay on the phone and the API works at the same time ("coexistence").
- Your Meta app must be a **Tech Provider** (Meta App Dashboard → WhatsApp → Quickstart → become a Tech Provider) with the WhatsApp product added and **Facebook Login for Business** set up.
- In **Facebook Login for Business → Configurations**, create a configuration of type *WhatsApp Embedded Signup*, then copy its **Configuration ID** into `META_EMBEDDED_SIGNUP_CONFIG_ID`.
- Add your domain to the app's **App domains** and **Allowed domains for the JavaScript SDK**.
- Also needed: `META_APP_ID`, `META_APP_SECRET`, and the platform webhook (`/webhooks/whatsapp`) subscribed in the Meta app.

**2. Scan QR code (WhatsApp Web style, unofficial).** Links any normal WhatsApp or WhatsApp Business number with no Meta setup, template approval or per-message fees. Buttons are sent as numbered options (the customer replies "1" to confirm), and voice notes and location pins still work.
- **Risk:** this is not an official API. WhatsApp can ban numbers that send bulk or unwanted messages. Use it for order updates to your own customers, and use the official option for marketing.
- It needs the small always-on **gateway** service in `gateway/`. Vercel can't host it, because it keeps a live connection open. Deploy it on Render:
  1. Render → **New → Web Service** → this repo, **Root Directory** `gateway`, build `npm install`, start `npm start`, plan *Starter*. Or use the `wa-commerce-gateway` service in `render.yaml`.
  2. Env vars:
     - `GATEWAY_SECRET`: any long random string.
     - `APP_WEBHOOK_URL`: `https://YOUR-DOMAIN/webhooks/gateway`.
     - `DATABASE_URL`: the same database as the app (Neon is fine).
     - `DATABASE_SSL=true`.
     Login sessions are stored there, so restarts don't log the phone out.
  3. In the main app (Vercel or Render), set `GATEWAY_URL` to the gateway's URL (e.g. `https://wa-commerce-gateway.onrender.com`) and set `GATEWAY_SECRET` to the same value. Redeploy.
  4. Open **Store → WhatsApp → Scan QR code** and scan with **WhatsApp → Linked devices → Link a device**. The store's current number keeps working until the scan succeeds.

**3. Enter API details**: paste the Phone number ID, WABA ID and a permanent token yourself.

## Reports for owners and the super admin

- **Store owners and team members:** **My profile** → WhatsApp number → **Send me the daily report**. The report covers every store in the business and is sent at the report time from the store's WhatsApp number (Cloud or QR). **Send me a sample now** sends one immediately.
- **Super admin:** **Super admin → Overview → Your daily platform report**. Set your number, the time (in `DEFAULT_TIMEZONE`) and which store's number sends it. You can also set `PLATFORM_REPORT_PHONE` as the default number. **Send now** sends one immediately, and past reports can be downloaded as PDFs.

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
