# WhatsApp Commerce Automation Platform for Shopify — Implementation Plan (v2)

Status: **implemented** (see README.md for setup). Target host: **Render**.

v2 changes the project from a single-store tool into a **multi-store platform** with roles, rich order messages, address verification, marketing, AI, owner reports and charts.

---

## 1. What the platform does

| # | Feature | Summary |
|---|---|---|
| 1 | **Multi-store accounts** | Each user signs up and links **multiple Shopify stores**. Each store has its own Shopify connection, WhatsApp number, templates, tags, AI settings, owner numbers and reports. |
| 2 | **Super admin** | One super admin sees **every account, store, order, message and campaign**, plus usage, health and audit logs, and can suspend or impersonate (impersonation is logged). |
| 3 | **Order sync** | New and updated orders arrive automatically in the portal from Shopify webhooks, with a reconciliation job that catches missed ones. |
| 4 | **Rich order confirmation** | A WhatsApp message with a **product image**, **product names, quantities and prices**, **customer name**, **store name**, **customer mobile**, **shipping address** and order total, plus **Confirm / Cancel / Change address** buttons. |
| 5 | **Shopify tagging** | Every outcome is tagged on the order (`wa-confirmed`, `wa-cancelled`, `address-verified`, …). Each store can rename the tags. |
| 6 | **Address confirmation (advanced)** | **Google Address Validation + Geocoding** score each address. Weak addresses trigger an address-check flow: the customer confirms it, shares a **location pin**, or types a new one. AI cleans the reply up, Google re-validates it, and the Shopify shipping address is updated. |
| 7 | **Tracking updates** | Shipped, out-for-delivery and delivered messages with a tracking button. |
| 8 | **Marketing** | Customer segments, broadcast campaigns, abandoned-cart recovery, win-back, post-delivery review requests, COD-to-prepaid offers, unique discount codes, click tracking and revenue attribution. Opt-ins and opt-outs are handled. |
| 9 | **AI layer (ChatGPT / OpenAI, optional Google Gemini)** | Understands free-text replies in any language (English, Urdu, Roman Urdu, Hindi, Arabic…). Includes an AI support agent that answers order questions, AI-written template and campaign copy, address parsing, fake-order risk scoring, and an AI summary of each report. |
| 10 | **Owner reports** | Each store adds one or more **owner WhatsApp numbers** and receives a **daily report** (plus optional weekly/monthly reports and instant alerts) with orders, revenue, confirmation rates and message stats, with charts as a PDF. |
| 11 | **Dashboards and charts** | Orders, revenue, confirmation funnel, message delivery, campaign ROI, address quality, AI usage and a city map. Available per store, across all of a user's stores, and globally for the super admin. |
| 12 | **Fully customizable** | Template builder (submits to Meta from the portal), automation flows (triggers, delays, conditions), tags, languages, quiet hours, branding, AI tone and knowledge base, report contents and schedule. |

---

## 2. Architecture

```
                        ┌───────────────────────── Render ─────────────────────────┐
Shopify stores ─webhooks─▶ API service (Express)                                    │
 (OAuth app)            │   /webhooks/shopify   ──▶ verify ▶ save ▶ enqueue          │
                        │   /webhooks/whatsapp  ──▶ verify ▶ route by phone_number_id │
Meta WhatsApp ─webhooks─▶   /api/*  (portal JSON API)                               │
 Cloud API ◀────────────│   /      (React portal static build)                       │
                        │                │                                         │
                        │                ▼                                         │
                        │        Postgres (all tenants)  ◀──────────┐               │
                        │                ▲                         │               │
                        │                │                         │               │
                        │   Worker service (pg-boss jobs + crons)  │               │
                        │   - send messages, throttled per store   │               │
                        │   - address checks (Google)              │               │
                        │   - AI calls (OpenAI)                    │               │
                        │   - campaigns, reports, reconciliation ──┘               │
                        └─────────────────────────────────────────────────────────┘
        External: Shopify Admin GraphQL · Meta Graph API · Google Maps Platform · OpenAI API
```

**Render services (`render.yaml` blueprint):**

| Service | Type | Notes |
|---|---|---|
| `wa-api` | Web Service (Starter or higher) | Express API, webhooks, serves the React build. Health check `/healthz`. |
| `wa-worker` | Background Worker | pg-boss consumers + cron. Kept separate so a big campaign never slows down webhooks. |
| `wa-db` | Postgres (paid) | Holds all tenant data and the pg-boss job queue. |

The free web plan sleeps and free Postgres expires, so neither can be used here. Redis is not needed: pg-boss handles queues, delays and cron.

---

## 3. Tech stack

| Layer | Choice |
|---|---|
| Backend | Node 20 LTS, ESM, Express 4, `zod` validation, `pino` logs (PII redacted) |
| DB | Postgres, `pg` + `node-pg-migrate` (SQL migrations), row-level tenant scoping in every query |
| Jobs | `pg-boss` (retries, delays, cron, per-store throttling via singleton keys) |
| Frontend | React + Vite + TypeScript, Tailwind + shadcn/ui, **Recharts** (charts), TanStack Query/Table, React Router |
| Maps in UI | Google Maps JavaScript API (address pin, city heatmap) |
| Auth | Email + password (bcrypt), httpOnly session cookies, optional 2FA (TOTP), roles and permissions |
| Shopify | Admin **GraphQL** API (pinned version), OAuth install |
| WhatsApp | **Meta WhatsApp Cloud API**, behind a provider interface (a different provider can be added later) |
| AI | **OpenAI API** (model set in config, e.g. `OPENAI_MODEL`), behind an `ai/` interface with optional **Google Gemini** |
| Google | Address Validation API, Geocoding API, Places Autocomplete (portal), Maps Static API (map image in messages/report) |
| PDF reports | `@react-pdf/renderer` or Playwright HTML→PDF (Chromium is available on Render via buildpack/Docker) |
| Phones | `libphonenumber-js` |
| Secrets at rest | AES-256-GCM with `ENCRYPTION_KEY` (Shopify tokens, WA tokens, per-store API keys) |

---

## 4. Multi-tenancy and roles

```
Super Admin (1, seeded from env)
  └── Account (a customer / business)  ── plan & limits
        ├── Users (roles: owner | admin | agent | viewer)
        └── Stores (many)
              ├── Shopify connection (OAuth token, encrypted)
              ├── WhatsApp number (phone_number_id, WABA id, token)
              ├── Owner report numbers (many)
              ├── Settings, templates, flows, tags, AI config, API keys
              └── Orders, customers, messages, campaigns, reports
```

* **Super admin:** global dashboard and charts, list/search every account, store, order and message; suspend accounts; set plan limits (stores, messages/month, AI tokens); view audit logs, failed jobs and system health; impersonate a user (logged in the audit log, with a visible banner).
* **Account owner:** add and remove stores, invite users, choose which stores each user can access, manage billing/plan (billing is phase 6, optional).
* **Agent:** works the inbox and orders for the stores they're assigned to. **Viewer:** read-only dashboards.
* **Isolation:** every row carries `store_id` (and `account_id`). An API middleware resolves the user's allowed store ids and every repository function requires them, so one store can't see another store's data. Tests prove a user can't read another account's data.

### 4.1 Linking a Shopify store
* **Primary:** a Shopify app created in the **Dev Dashboard** with **custom or unlisted distribution**. The user clicks *Connect store* and enters `xxx.myshopify.com`, the OAuth install runs, and the platform stores the offline token (encrypted).
* **Fallback:** paste a custom-app Admin token + API secret for a store (useful for stores that can't install the app).
* On connect, the platform registers webhooks via GraphQL: `ORDERS_CREATE`, `ORDERS_UPDATED`, `ORDERS_CANCELLED`, `FULFILLMENTS_CREATE`, `FULFILLMENTS_UPDATE`, `CHECKOUTS_CREATE`, `CHECKOUTS_UPDATE`, `CUSTOMERS_CREATE`, `CUSTOMERS_UPDATE`, `APP_UNINSTALLED`, plus the mandatory privacy webhooks (`customers/data_request`, `customers/redact`, `shop/redact`).
* Incoming webhooks are routed by the `X-Shopify-Shop-Domain` header and HMAC-verified with the matching secret.
* Scopes: `read_orders, write_orders, read_customers, write_customers, read_products, read_fulfillments, read_checkouts, write_discounts, read_locations`.
* **Protected customer data** (name, phone, email, address) must be requested and approved in the app config, or these fields arrive empty.

### 4.2 Linking a WhatsApp number (per store)
* **Phase 1 (manual):** the store pastes its `phone_number_id`, `waba_id` and a permanent System User token. The platform tests them and shows the number's name and quality rating.
* **Phase 5 (one-click):** **Meta Embedded Signup**. This needs the platform to become a Meta **Tech Provider**.
* All numbers point at one webhook `POST /webhooks/whatsapp`. The worker routes each event using `metadata.phone_number_id` → store. Stores connected manually with their own Meta app use `/webhooks/whatsapp/:storeKey` with that store's own app secret.
* Several stores may share one WhatsApp number. Replies are then matched to the store using the customer's latest order.

---

## 5. Order confirmation message (with product info and image)

### 5.1 Template (Meta "Utility", one per language)
```
[HEADER: IMAGE  ← first product's image]
Hi {{1}} 👋, thank you for shopping at *{{2}}*!
Order *{{3}}* | Items: {{4}}
Total: *{{5}}* ({{6}})
Mobile: {{7}}
Delivery address: {{8}}
Please confirm your order below.
[✅ Confirm order] [📍 Change address] [❌ Cancel order]
```
| Var | Source |
|---|---|
| header image | Product/variant featured image from Shopify GraphQL (public Shopify CDN URL) |
| {{1}} customer name | shipping name → customer first name |
| {{2}} store name | store settings (default: Shopify shop name) |
| {{3}} order no. | `order.name` |
| {{4}} items | `2× Candle Set (Rs 1,500) · 1× Battery (Rs 300)`, cut to fit with "+N more" |
| {{5}} total / {{6}} payment | formatted in the store's currency; "Cash on Delivery" / "Paid" |
| {{7}} mobile | normalised customer number |
| {{8}} address | single-line formatted shipping address |

**Meta rules the builder enforces:**
* Parameter values can't contain newlines, tabs or more than 4 spaces in a row (error 132018), so item lists use ` · ` separators.
* The body is at most 1024 characters.
* The body can't start or end with a variable.

**Multi-product orders:** the header shows the first product's image. Optionally (setting) a **media-card carousel template** sends up to 10 product cards, each with an image, name and price. After the customer replies, the 24-hour free window is open, so extra product images can also be sent as normal image messages at no template cost.

### 5.2 Reply handling
* **Confirm** → `wa-confirmed` tag, status `confirmed`, thank-you message, plus a COD→prepaid offer if enabled.
* **Cancel** → AI/menu asks for a reason (list message), then `wa-cancelled` tag. Auto-cancelling in Shopify is a per-store setting.
* **Change address** → the address flow (§6).
* **Free text or voice note** → AI intent detection (§8) maps it to confirm, cancel, change address, question or other. Unclear messages go to the **Inbox** for a human.
* **Reminders:** if there's no reply, a reminder at +X h, then a `wa-no-response` tag at +Y h. Optional: an AI-generated call script for the agent, with a "Mark as called" button.

---

## 6. Advanced address confirmation

1. **Auto-score on order sync.** The worker calls Google **Address Validation API** (region from the store's country). It stores the verdict (`addressComplete`, `hasUnconfirmedComponents`, missing house or street number), geocode lat/lng and the formatted address, and computes an **address score 0–100**. For countries where Address Validation has weak coverage, it falls back to **Geocoding API** with `location_type`, plus AI checks (missing house number, landmark or area).
2. **Rules per store:** score ≥ 80 → `address-verified`. Score 50–79 → ask the customer to confirm. Score < 50 → ask the customer for a corrected address. The thresholds can be changed.
3. **WhatsApp flow:**
   * Message: "Is this your correct address? {{address}}" with a **Maps Static** image of the pin and the buttons [✅ Yes] [✏️ Update].
   * Update → the customer can **share their location** (WhatsApp location message, converted to an address with reverse geocoding) or **type the address**. Typed addresses are **parsed by AI** into a structured address (address1, address2, city, province, zip, landmark), then re-validated by Google.
   * Optional: a **WhatsApp Flow** (native form inside WhatsApp) with address fields.
   * The platform repeats the new address back to the customer for a final confirmation.
4. **Write back to Shopify:** `orderUpdate(input: { id, shippingAddress })`. Tags `address-updated` / `address-verified` / `address-issue`. The original address is kept in the audit log.
5. **Portal:** a map pin on the order page, the address score, the Google verdict details, and a manual edit field with Places Autocomplete.
6. **Extra checks:** delivery-zone / unserviceable-city list per store, duplicate-address detection, and a fake-order signal (§8).

---

## 7. Marketing module

| Feature | Details |
|---|---|
| **Opt-in management** | WhatsApp policy requires opt-in before marketing messages. Sources: Shopify SMS/marketing consent, a "Get offers on WhatsApp" button after an order is confirmed, an opt-in widget/link (wa.me with a keyword), CSV import with a consent declaration. **STOP / unsubscribe** keywords, recognised by AI in any language, opt the customer out right away. |
| **Customers** | Synced from Shopify: orders count, total spent, last order, AOV, city, tags, products bought. **RFM segmentation** runs automatically. |
| **Segment builder** | Visual AND/OR rules: spent > X, last order > 60 days, city in […], bought product Y, tag Z, opted-in, confirmation history. Shows a live count. |
| **Campaigns** | Pick a template (image/video/document header, buttons), pick a segment, personalise with variables, **schedule** (in the store's timezone, with quiet hours), **A/B test** two templates, throttle to stay within the number's Meta messaging limit and quality rating. |
| **Automations** | Abandoned checkout (multi-step: 30 min, 6 h, 24 h, with a discount on the last step); welcome message for new customers; post-delivery review/feedback request; win-back at 60/90 days; restock/upsell suggestions based on what was bought; birthday (if the data exists); COD→prepaid conversion with a discount. |
| **Discount codes** | Unique per recipient via `discountCodeBasicCreate`, with expiry and minimum order. Each code is linked to the campaign for attribution. |
| **Tracking** | Short links `APP_BASE_URL/r/:code` with UTM tags log clicks. **Revenue attribution:** orders using the campaign's code or UTM, or from a messaged customer within N days. |
| **Campaign analytics** | Sent → delivered → read → clicked → ordered funnel, revenue, ROI vs. Meta message cost, A/B winner. |
| **AI assist** | "Write a campaign for Eid sale, friendly tone, Roman Urdu", which returns 3 variants with emoji/CTA suggestions. AI can also draft templates in the right Meta category, check them against Meta template guidelines before submitting, and suggest the best send time from past read rates. |

---

## 8. AI system

All AI goes through an `ai/` service with per-store config: on/off per feature, tone, language, model, and either the platform's key or the store's own OpenAI/Gemini key. Usage limits are tracked per store, every request and response is logged (PII masked), and AI never takes destructive actions (cancel, address overwrite) without the customer clearly confirming.

| AI feature | How |
|---|---|
| **Intent detection** | Classifies every inbound text: `confirm, cancel, change_address, where_is_order, question, complaint, opt_out, other`. Returns JSON (structured outputs) with a confidence score. Below the threshold the message goes to a human. |
| **Multilingual** | Detects the language/script and replies in the same language (Roman Urdu supported). |
| **Voice notes** | Transcribes audio messages (OpenAI speech-to-text), then runs intent detection. |
| **AI support agent** | Answers "where is my order?", "can I change size?" and policy questions. Has **tools** to look up the order, tracking, address status and store FAQ, and a knowledge base per store (policies, FAQs, shipping times, pasted text/URLs). It hands off to a human on complaints, low confidence or when the customer asks. Business hours and quiet hours are respected. |
| **Address parsing** | Turns free-text addresses into structured fields; works together with Google validation. |
| **Copywriting** | Templates, campaigns, product descriptions for messages, reply suggestions in the inbox ("✨ Suggest reply"). |
| **Fake / risky COD order score** | Combines rules and AI: address score, phone validity, past cancellations or refusals for this phone/address, order value, unusual quantity, repeat orders from the same IP, name quality. High risk → `risk-high` tag, a stricter confirmation flow, and an owner alert. |
| **Report insights** | Writes a plain-language daily summary: "Confirmation rate dropped 12% vs last week, mostly Karachi orders. 18 orders waiting >24h." |
| **Ask your data** | A portal chat ("How many orders did Store B confirm last week?"). The model only gets **read-only, store-scoped query tools**, never raw SQL. |

---

## 9. Owner reports and alerts

* **Per store:** a list of owner numbers (name, number, which reports, language) and a send time in the store's timezone. A combined report across all of an account's stores is also available.
* **Daily report** (WhatsApp utility template `daily_report` with a **document header = PDF**):
  * Orders and revenue (today vs yesterday vs 7-day average)
  * Confirmed / cancelled / no-response / pending counts and %
  * Address verified / updated / issues
  * Messages sent / delivered / read / failed, and estimated Meta cost
  * Campaign sends, clicks and attributed revenue
  * Shipped / delivered / returned
  * Top products, top cities
  * **AI summary + 3 recommended actions**
  * The PDF has the charts. The template body has the key numbers, so it can be read without opening the PDF.
* **Weekly / monthly** reports in the same format.
* **Instant alerts** (each can be turned on or off): high-value order, high-risk order, failed-message spike, WhatsApp **quality rating drop / messaging limit change** (from the Meta webhook), store disconnected, low confirmation rate.
* **Super admin** gets a platform report: new accounts, stores, total messages, errors, AI spend.
* Reports are also listed in the portal **Reports** page (view, download, resend).

---

## 10. Portal (React)

| Area | Pages |
|---|---|
| **Dashboard** | KPI cards + charts: orders/revenue over time, **confirmation funnel**, message status mix, address score distribution, campaign ROI, AI-handled vs human, **city map**. Store switcher + "All stores" view. Date range picker. |
| **Orders** | Table with filters (status, store, date, payment, risk, address score, tags), bulk actions (resend, tag, export CSV). Order detail: products with images, customer, address + map, Shopify tags, **conversation timeline**, AI risk, manual actions. |
| **Inbox** | WhatsApp-style shared inbox per store: chats, assign to an agent, AI suggested replies, quick replies, send image/product, 24h window indicator, "AI handled" badge. |
| **Customers** | List, profile (orders, messages, opt-in status, RFM), segment builder. |
| **Marketing** | Campaigns, automations, discount codes, campaign analytics. |
| **Templates** | Builder with live WhatsApp preview, variable picker (all order/customer/store fields), media header upload, buttons; **submit to Meta via API**, approval status sync, multi-language versions, AI "write for me". |
| **Automations / Flows** | Visual list of triggers → conditions → delays → actions (send template, add tag, AI step, update address, notify owner). Ships with ready-made flows (confirmation, address, tracking, abandoned cart, review). |
| **Reports** | Report history, schedules, owner numbers. |
| **Settings (per store)** | Shopify connection, WhatsApp number, tags mapping, languages, quiet hours, timezone/currency, address thresholds, AI config + knowledge base, API keys (OpenAI, Google), branding (logo/colors for PDF reports), team access. |
| **Super admin** | Accounts, stores, global orders/messages search, usage and limits, plans, audit log, job queue monitor, system health, global settings, impersonate. |

The portal supports light and dark mode, works on mobile (owners check it on their phones), and has English UI text with i18n ready for Urdu/Arabic (RTL).

---

## 11. Data model (main tables)

```
accounts(id, name, plan, limits jsonb, status, created_at)
users(id, email, password_hash, name, is_super_admin, totp_secret, created_at)
memberships(user_id, account_id, role, store_ids int[] null /* null = all */)
stores(id, account_id, name, shopify_domain, shopify_token_enc, shopify_scopes, webhook_secret_enc,
       currency, timezone, country, logo_url, status, settings jsonb, created_at)
whatsapp_numbers(id, store_id, phone_number_id, waba_id, display_number, token_enc,
       app_secret_enc, quality_rating, messaging_limit, status)
owner_contacts(id, store_id null, account_id, name, phone_e164, reports text[], language)
api_keys(id, store_id, provider /* openai|google|gemini */, key_enc)

customers(id, store_id, shopify_customer_id, name, phone_e164, email, city,
          orders_count, total_spent, last_order_at, rfm_segment, tags text[],
          wa_opt_in bool, opt_in_source, opt_in_at, opted_out_at)
orders(id, store_id, shopify_order_id, name, customer_id, phone_e164, total, currency,
       gateway, is_cod, shipping_address jsonb, status, address_status, address_score,
       geo point, risk_score, risk_reasons jsonb, shopify_tags text[], needs_attention,
       shopify_created_at, confirmed_at, ...)
order_items(id, order_id, product_id, variant_id, title, variant_title, sku, qty, price, image_url)
fulfillments(id, order_id, shopify_fulfillment_id, tracking_number, company, url,
             shipment_status, notified jsonb)
address_checks(id, order_id, source /* google|ai|customer */, input jsonb, result jsonb, score, created_at)
checkouts(id, store_id, shopify_checkout_id, customer_id, phone, cart jsonb, total,
          recovered_order_id, status)

conversations(id, store_id, customer_id, phone_e164, assigned_user_id, last_inbound_at, status)
messages(id, store_id, conversation_id, order_id, campaign_id, direction, kind, template_id,
         wa_message_id unique, body, media jsonb, payload jsonb, status, error_code,
         cost_estimate, ai_generated bool, created_at)
templates(id, store_id, name, language, category, components jsonb, meta_template_id,
          status, variable_map jsonb)
flows(id, store_id, trigger, definition jsonb, enabled)
segments(id, store_id, name, rules jsonb)
campaigns(id, store_id, name, template_id, segment_id, variant_b_template_id, schedule_at,
          status, stats jsonb)
campaign_recipients(campaign_id, customer_id, variant, message_id, discount_code, clicked_at,
                    order_id, revenue)
short_links(code pk, store_id, target_url, campaign_id, customer_id, clicks)
ai_logs(id, store_id, feature, model, input_tokens, output_tokens, cost, latency_ms, created_at)
reports(id, store_id null, account_id, type, period, data jsonb, pdf_url, sent_to jsonb, created_at)
webhook_events(id pk, source, store_id, topic, received_at)   -- dedupe
audit_logs(id, actor_user_id, impersonated_by, account_id, store_id, action, target, diff jsonb, created_at)
usage_counters(account_id, month, messages, ai_tokens, address_checks)
```

Indexes: `(store_id, created_at)` on orders and messages, `(store_id, phone_e164)` on customers and conversations, plus GIN indexes on tags.

---

## 12. Project structure

```
apps/
  api/src/
    index.js, config.js
    middleware/ auth.js, tenant.js, rateLimit.js, errors.js
    routes/ auth, stores, orders, inbox, customers, campaigns, templates, flows,
            reports, settings, dashboard, admin/*, webhooks/shopify, webhooks/whatsapp, r (short links)
  worker/src/
    index.js            # pg-boss consumers + crons
    jobs/ sendMessage, confirmation, reminder, addressCheck, tracking, abandonedCart,
          campaignDispatch, campaignBatch, dailyReport, alerts, reconcileOrders,
          syncCustomers, syncTemplates, rfm, aiInsights
  web/                  # React + Vite portal
packages/core/src/      # shared by api + worker
  db/ (pool, migrations, repositories/*)   # every repository function takes storeId
  shopify/ (oauth, client, webhooks, orders, products, discounts, registerWebhooks)
  whatsapp/ (provider, cloudApi, templates, webhookParser, throttle)
  google/ (addressValidation, geocode, staticMap)
  ai/ (provider, openai, gemini, prompts/*, intent, agent, addressParser, copywriter, risk, insights)
  flows/ (engine: trigger → conditions → actions)
  reports/ (builder, pdf)
  crypto.js, phone.js, money.js, i18n/
legacy/bundle-splitter  # existing code, ported as an optional per-store feature
render.yaml, .env.example
```

---

## 13. Environment variables (platform level)

```
DATABASE_URL, APP_BASE_URL, SESSION_SECRET, ENCRYPTION_KEY (32-byte base64)
SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD           # seeded once
SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_SCOPES, SHOPIFY_API_VERSION
META_APP_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, META_GRAPH_VERSION
OPENAI_API_KEY, OPENAI_MODEL, OPENAI_TRANSCRIBE_MODEL
GEMINI_API_KEY (optional)
GOOGLE_MAPS_API_KEY (server: Address Validation, Geocoding, Static Maps)
GOOGLE_MAPS_BROWSER_KEY (referrer-restricted, portal maps)
LOG_LEVEL, DEFAULT_COUNTRY, DEFAULT_TIMEZONE
```
Per-store keys (WhatsApp tokens, and optionally each store's own OpenAI/Google keys) are entered in the portal and stored encrypted.

---

## 14. Reliability, security, compliance

* **Webhooks:** HMAC checks (Shopify) and `X-Hub-Signature-256` checks (Meta) with `timingSafeEqual` on the raw body. Handlers answer 200 quickly; the work is done later by the worker. Duplicate deliveries are ignored (`webhook_events`).
* **Throttling:** a send rate limit per WhatsApp number. Campaigns are split into batches that respect the number's messaging limit, and sending pauses automatically if its quality rating drops to RED. Shopify GraphQL calls back off based on the query cost.
* **Retries:** exponential backoff. Permanent errors (number not on WhatsApp, template paused) are not retried. Failed jobs appear in the portal and the super-admin queue monitor.
* **Security:** secrets encrypted (AES-GCM), RBAC on every route, tenant scoping enforced in repositories, CSRF protection, rate-limited login, optional 2FA, audit log on settings changes, impersonation and destructive actions.
* **Privacy:** Shopify privacy webhooks implemented (export/redact customer, shop redact), data-retention setting per account, PII masked in logs and AI logs, AI data sent with minimal fields.
* **WhatsApp policy:** marketing only to opted-in customers, opt-out respected right away, templates in the correct category, 24h window enforced in the inbox.
* **Costs shown in the portal:** an estimate of Meta charges (marketing messages cost much more than utility ones), AI tokens and Google API calls, per store, so owners can see their spend.

---

## 15. Testing

* Unit tests: signature checks, phone/money formatting, template variable building (Meta rules), flow engine, segment rule → SQL, risk scoring, RFM.
* AI: prompt regression set (about 100 real-style multilingual replies → expected intent); runs in CI with a mocked model plus an optional live run.
* Integration: recorded Shopify and Meta webhook payloads → expected DB state, tags and outgoing API calls (`nock`).
* **Tenant isolation tests** for every API route.
* End-to-end: Playwright on the portal; a manual run on a Shopify development store with a Meta test number.

---

## 16. Delivery phases

| Phase | Scope | Result |
|---|---|---|
| **0. Foundation** | Monorepo, Postgres + migrations, pg-boss, auth + roles + super admin, account/store CRUD, encryption, `render.yaml` (api + worker + db), React shell | Deployable skeleton with login |
| **1. Store linking + order sync** | Shopify OAuth + token fallback, webhook registration and routing, order/customer/product sync, reconciliation, orders UI | Multiple stores per user, orders flowing into the portal |
| **2. WhatsApp confirmation + tags** | Number linking, template builder + Meta submission, rich confirmation (image, products, prices, name, store, mobile, address), buttons, reminders, tagging, inbox v1 | Core confirmation loop working |
| **3. Address + tracking** | Google validation + scoring, address flow (location pin, AI parsing, write-back), map UI, tracking/delivery messages | Verified addresses, tracking updates |
| **4. AI + owner reports + charts** | Intent detection, multilingual, voice notes, AI agent with handoff, risk score, dashboards with charts, daily/weekly PDF reports to owner numbers, alerts, super-admin dashboards | "AI system" + reporting |
| **5. Marketing** | Opt-ins, segments, campaigns + A/B, automations (abandoned cart, win-back, review, COD→prepaid), discount codes, short links, attribution, AI copywriter | Full marketing suite |
| **6. Scale + SaaS** | Meta Embedded Signup (Tech Provider), plans/limits + billing (Stripe), "ask your data", WhatsApp Flows forms, carousel templates, i18n UI | Ready to sell to other merchants |

Each phase ends deployed on Render and tested on a development store before the next one starts.

---

## 17. Decisions needed

1. **Who are the users?** Only your own stores and team (internal tool), or **other merchants signing up** (SaaS)? SaaS needs a Meta Tech Provider application, billing, and a Shopify app with more formal review. The plan supports both, but this decides how much of phase 6 is needed.
2. **WhatsApp:** Meta Cloud API for every store (recommended)? Does each store have its **own number**, or do some stores share one?
3. **Confirmation scope default:** all orders, or COD only?
4. **Cancel button:** tag only, or also cancel the order in Shopify? This will be a per-store setting; which should be the default?
5. **Main country and languages** (e.g. Pakistan: English + Urdu + Roman Urdu)? This decides default templates, phone parsing, and how much to rely on Google Address Validation (coverage differs by country).
6. **AI keys:** one platform OpenAI/Google key for everyone (you pay and set limits), or **each store brings its own**? Or both?
7. **Keep the bundle splitter** as an optional per-store feature?
