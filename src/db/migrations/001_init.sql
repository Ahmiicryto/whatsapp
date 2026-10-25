-- ============ Tenancy & auth ============
CREATE TABLE accounts (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'standard',
  limits jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active', -- active | suspended
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id bigserial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text,
  is_super_admin boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','agent','viewer')),
  store_ids bigint[], -- NULL = all stores in the account
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, account_id)
);

CREATE TABLE sessions (
  id text PRIMARY KEY, -- sha256 of the cookie token
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  impersonator_id bigint REFERENCES users(id) ON DELETE CASCADE,
  active_account_id bigint REFERENCES accounts(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- ============ WhatsApp numbers & stores ============
CREATE TABLE whatsapp_numbers (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_number_id text NOT NULL UNIQUE,
  waba_id text,
  display_number text,
  verified_name text,
  token_enc text NOT NULL,
  app_secret_enc text,        -- set when the number belongs to the merchant's own Meta app
  webhook_key text NOT NULL UNIQUE,
  quality_rating text,
  messaging_limit text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stores (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  shopify_domain text NOT NULL UNIQUE,
  shopify_token_enc text,
  shopify_scopes text,
  webhook_secret_enc text,    -- NULL => use the platform app's API secret
  connection_type text NOT NULL DEFAULT 'manual', -- oauth | manual
  whatsapp_number_id bigint REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  currency text NOT NULL DEFAULT 'USD',
  timezone text NOT NULL DEFAULT 'UTC',
  country text,
  logo_url text,
  status text NOT NULL DEFAULT 'active', -- active | paused | disconnected
  settings jsonb NOT NULL DEFAULT '{}',
  webhooks_registered_at timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stores_account_idx ON stores(account_id);

CREATE TABLE oauth_states (
  state text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shop text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE owner_contacts (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id bigint REFERENCES stores(id) ON DELETE CASCADE, -- NULL = combined account report
  name text NOT NULL,
  phone_e164 text NOT NULL,
  reports text[] NOT NULL DEFAULT '{daily,alerts}',
  language text NOT NULL DEFAULT 'en',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  provider text NOT NULL, -- openai | gemini | google
  key_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, provider)
);

-- ============ Commerce data ============
CREATE TABLE customers (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_customer_id bigint,
  name text,
  first_name text,
  phone_e164 text,
  email text,
  city text,
  country text,
  orders_count int NOT NULL DEFAULT 0,
  total_spent numeric NOT NULL DEFAULT 0,
  first_order_at timestamptz,
  last_order_at timestamptz,
  rfm_segment text,
  tags text[] NOT NULL DEFAULT '{}',
  wa_opt_in boolean NOT NULL DEFAULT false,
  opt_in_source text,
  opt_in_at timestamptz,
  opted_out_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, shopify_customer_id)
);
CREATE INDEX customers_phone_idx ON customers(store_id, phone_e164);
CREATE INDEX customers_tags_idx ON customers USING gin(tags);

CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  customer_id bigint REFERENCES customers(id) ON DELETE SET NULL,
  shopify_order_id bigint NOT NULL,
  name text NOT NULL,
  customer_name text,
  first_name text,
  phone_e164 text,
  phone_raw text,
  email text,
  total numeric NOT NULL DEFAULT 0,
  subtotal numeric,
  currency text,
  gateway text,
  is_cod boolean NOT NULL DEFAULT false,
  financial_status text,
  fulfillment_status text,
  shipping_address jsonb,
  address_text text,
  address_status text NOT NULL DEFAULT 'unchecked',
  -- unchecked | verified | needs_confirmation | needs_update | awaiting_customer | updated | issue
  address_score int,
  lat double precision,
  lng double precision,
  status text NOT NULL DEFAULT 'new',
  -- new | no_phone | not_eligible | awaiting_reply | confirmed | cancelled_by_customer | no_response | cancelled | fulfilled | delivered
  cancel_reason text,
  risk_score int,
  risk_reasons jsonb,
  shopify_tags text[] NOT NULL DEFAULT '{}',
  discount_codes text[] NOT NULL DEFAULT '{}',
  needs_attention boolean NOT NULL DEFAULT false,
  order_status_url text,
  checkout_token text,
  source text NOT NULL DEFAULT 'webhook',
  confirmation_sent_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  shopify_created_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, shopify_order_id)
);
CREATE INDEX orders_store_created_idx ON orders(store_id, shopify_created_at DESC);
CREATE INDEX orders_store_status_idx ON orders(store_id, status);
CREATE INDEX orders_phone_idx ON orders(store_id, phone_e164);
CREATE INDEX orders_tags_idx ON orders USING gin(shopify_tags);

CREATE TABLE order_items (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_line_item_id bigint,
  product_id bigint,
  variant_id bigint,
  title text NOT NULL,
  variant_title text,
  sku text,
  quantity int NOT NULL DEFAULT 1,
  price numeric NOT NULL DEFAULT 0,
  image_url text
);
CREATE INDEX order_items_order_idx ON order_items(order_id);
CREATE INDEX order_items_product_idx ON order_items(store_id, product_id);

CREATE TABLE fulfillments (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shopify_fulfillment_id bigint NOT NULL UNIQUE,
  status text,
  tracking_number text,
  tracking_company text,
  tracking_url text,
  shipment_status text,
  notified jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE address_checks (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  source text NOT NULL, -- google_validation | google_geocode | ai | customer_text | customer_location | manual
  input jsonb,
  result jsonb,
  score int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX address_checks_order_idx ON address_checks(order_id);

CREATE TABLE checkouts (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  token text NOT NULL,
  customer_id bigint REFERENCES customers(id) ON DELETE SET NULL,
  phone_e164 text,
  name text,
  email text,
  total numeric,
  currency text,
  line_items jsonb,
  recovery_url text,
  accepts_marketing boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open', -- open | completed | recovered
  steps_sent int NOT NULL DEFAULT 0,
  completed_at timestamptz,
  recovered_order_id bigint REFERENCES orders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, token)
);

-- ============ Messaging ============
CREATE TABLE conversations (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  customer_id bigint REFERENCES customers(id) ON DELETE SET NULL,
  phone_e164 text NOT NULL,
  name text,
  assigned_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  last_inbound_at timestamptz,
  last_message_at timestamptz,
  last_message_preview text,
  unread int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open', -- open | resolved
  needs_human boolean NOT NULL DEFAULT false,
  state jsonb NOT NULL DEFAULT '{}',
  ai_paused_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, phone_e164)
);
CREATE INDEX conversations_store_last_idx ON conversations(store_id, last_message_at DESC);

CREATE TABLE templates (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind text NOT NULL,           -- order_confirmation | order_reminder | ... | custom
  name text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  category text NOT NULL DEFAULT 'UTILITY',
  header jsonb,                 -- {format: NONE|TEXT|IMAGE|DOCUMENT|VIDEO, text, source, url}
  body text NOT NULL,
  footer text,
  buttons jsonb NOT NULL DEFAULT '[]', -- [{type: QUICK_REPLY|URL|PHONE_NUMBER, text, action, url, source, phone}]
  variables jsonb NOT NULL DEFAULT '[]', -- body variable sources, index = {{n}}-1
  meta_template_id text,
  status text NOT NULL DEFAULT 'draft', -- draft | PENDING | APPROVED | REJECTED | PAUSED | DISABLED
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, name, language)
);
CREATE INDEX templates_kind_idx ON templates(store_id, kind);

CREATE TABLE segments (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name text NOT NULL,
  rules jsonb NOT NULL DEFAULT '{"match":"all","conditions":[]}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name text NOT NULL,
  template_id bigint REFERENCES templates(id) ON DELETE SET NULL,
  template_b_id bigint REFERENCES templates(id) ON DELETE SET NULL,
  ab_split int NOT NULL DEFAULT 50,
  segment_id bigint REFERENCES segments(id) ON DELETE SET NULL,
  variables jsonb NOT NULL DEFAULT '{}',   -- static values e.g. {"campaign.text": "..."}
  header_media_url text,
  link_url text,
  discount jsonb,                          -- {percent: 10, days: 7}
  schedule_at timestamptz,
  status text NOT NULL DEFAULT 'draft',    -- draft | scheduled | sending | sent | cancelled | failed
  stats jsonb NOT NULL DEFAULT '{}',
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  conversation_id bigint REFERENCES conversations(id) ON DELETE SET NULL,
  order_id bigint REFERENCES orders(id) ON DELETE SET NULL,
  customer_id bigint REFERENCES customers(id) ON DELETE SET NULL,
  campaign_id bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  direction text NOT NULL, -- out | in
  kind text NOT NULL,
  template_name text,
  category text,           -- marketing | utility | service
  wa_message_id text UNIQUE,
  to_phone text,
  body text,
  media jsonb,
  payload jsonb,
  status text NOT NULL DEFAULT 'queued', -- queued | sent | delivered | read | failed | received
  error_code text,
  error_text text,
  cost_estimate numeric NOT NULL DEFAULT 0,
  ai_generated boolean NOT NULL DEFAULT false,
  sent_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_store_created_idx ON messages(store_id, created_at DESC);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);
CREATE INDEX messages_order_idx ON messages(order_id);
CREATE INDEX messages_campaign_idx ON messages(campaign_id);

CREATE TABLE campaign_recipients (
  id bigserial PRIMARY KEY,
  campaign_id bigint NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  variant char(1) NOT NULL DEFAULT 'A',
  status text NOT NULL DEFAULT 'pending', -- pending | sent | failed | skipped
  message_id bigint REFERENCES messages(id) ON DELETE SET NULL,
  discount_code text,
  short_code text,
  clicked_at timestamptz,
  order_id bigint REFERENCES orders(id) ON DELETE SET NULL,
  revenue numeric,
  UNIQUE (campaign_id, customer_id)
);
CREATE INDEX campaign_recipients_code_idx ON campaign_recipients(discount_code);

CREATE TABLE short_links (
  code text PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  target_url text NOT NULL,
  kind text,
  campaign_id bigint REFERENCES campaigns(id) ON DELETE CASCADE,
  recipient_id bigint REFERENCES campaign_recipients(id) ON DELETE CASCADE,
  order_id bigint REFERENCES orders(id) ON DELETE CASCADE,
  clicks int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media_files (
  id bigserial PRIMARY KEY,
  store_id bigint REFERENCES stores(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  filename text,
  mime text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ AI, reports, ops ============
CREATE TABLE ai_logs (
  id bigserial PRIMARY KEY,
  store_id bigint REFERENCES stores(id) ON DELETE CASCADE,
  feature text NOT NULL,
  provider text NOT NULL,
  model text,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  latency_ms int,
  ok boolean NOT NULL DEFAULT true,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_logs_store_idx ON ai_logs(store_id, created_at DESC);

CREATE TABLE reports (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id bigint REFERENCES stores(id) ON DELETE CASCADE,
  type text NOT NULL, -- daily | weekly | monthly | platform
  period_key text NOT NULL,
  data jsonb NOT NULL,
  pdf bytea,
  sent_to jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reports_unique_idx ON reports(account_id, COALESCE(store_id, 0), type, period_key);

CREATE TABLE alerts (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id bigint REFERENCES stores(id) ON DELETE CASCADE,
  kind text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id text PRIMARY KEY,
  source text NOT NULL,
  store_id bigint,
  topic text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  impersonator_id bigint REFERENCES users(id) ON DELETE SET NULL,
  account_id bigint REFERENCES accounts(id) ON DELETE CASCADE,
  store_id bigint REFERENCES stores(id) ON DELETE SET NULL,
  action text NOT NULL,
  target text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_account_idx ON audit_logs(account_id, created_at DESC);

CREATE TABLE usage_counters (
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month text NOT NULL,
  messages int NOT NULL DEFAULT 0,
  marketing_messages int NOT NULL DEFAULT 0,
  ai_tokens int NOT NULL DEFAULT 0,
  address_checks int NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
);

-- ============ Job queue ============
CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  singleton_key text,
  store_id bigint,
  last_error text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs(run_at) WHERE status = 'queued';
CREATE UNIQUE INDEX jobs_singleton_idx ON jobs(singleton_key) WHERE status IN ('queued','running');
CREATE INDEX jobs_failed_idx ON jobs(store_id, updated_at DESC) WHERE status = 'failed';

CREATE TABLE cron_runs (
  name text NOT NULL,
  slot text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, slot)
);
