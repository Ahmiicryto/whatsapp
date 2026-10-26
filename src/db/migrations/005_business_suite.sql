-- Business suite: notifications, couriers & COD, fraud protection, profit, billing,
-- back-in-stock, reviews, inbox tools, automation rules, public API and outgoing webhooks.

-- ============ In-app notifications ============
CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  account_id bigint REFERENCES accounts(id) ON DELETE CASCADE, -- NULL = platform (super admin)
  store_id bigint REFERENCES stores(id) ON DELETE CASCADE,
  user_id bigint REFERENCES users(id) ON DELETE CASCADE,       -- NULL = everyone in the account
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'info', -- info | success | warning | danger
  title text NOT NULL,
  body text,
  link text,
  read_by bigint[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_account_idx ON notifications(account_id, created_at DESC);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_prefs jsonb NOT NULL DEFAULT '{}';

-- ============ Couriers & shipments ============
CREATE TABLE store_couriers (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  provider text NOT NULL, -- postex | leopards | trax | custom | manual
  name text NOT NULL,
  credentials_enc text,
  settings jsonb NOT NULL DEFAULT '{}',
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX store_couriers_store_idx ON store_couriers(store_id);

CREATE TABLE shipments (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  courier_id bigint REFERENCES store_couriers(id) ON DELETE SET NULL,
  provider text NOT NULL,
  courier_name text,
  tracking_number text,
  tracking_url text,
  label_url text,
  status text NOT NULL DEFAULT 'booked',
  -- booked | in_transit | out_for_delivery | delivered | attempted | refused | returning | returned | cancelled
  status_raw text,
  cod_amount numeric NOT NULL DEFAULT 0,
  fee numeric,
  weight_kg numeric,
  events jsonb NOT NULL DEFAULT '[]',
  notified jsonb NOT NULL DEFAULT '{}',
  reschedule jsonb,
  attempts int NOT NULL DEFAULT 0,
  cod_settled_at timestamptz,
  settlement_ref text,
  booked_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  returned_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipments_store_idx ON shipments(store_id, booked_at DESC);
CREATE INDEX shipments_order_idx ON shipments(order_id);
CREATE INDEX shipments_open_idx ON shipments(status) WHERE status NOT IN ('delivered','returned','cancelled');
CREATE UNIQUE INDEX shipments_tracking_idx ON shipments(provider, tracking_number) WHERE tracking_number IS NOT NULL;

-- ============ Fraud protection & advance payments ============
CREATE TABLE blocklist (
  id bigserial PRIMARY KEY,
  account_id bigint REFERENCES accounts(id) ON DELETE CASCADE, -- NULL = platform-wide (super admin)
  phone_e164 text NOT NULL,
  reason text,
  source text NOT NULL DEFAULT 'manual', -- manual | auto_returns
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX blocklist_unique_idx ON blocklist(COALESCE(account_id, 0), phone_e164);
CREATE INDEX orders_phone_global_idx ON orders(phone_e164);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS advance_amount numeric,
  ADD COLUMN IF NOT EXISTS advance_status text NOT NULL DEFAULT 'none', -- none | requested | paid | waived
  ADD COLUMN IF NOT EXISTS advance_link text,
  ADD COLUMN IF NOT EXISTS advance_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS ad_source jsonb,
  ADD COLUMN IF NOT EXISTS upsell jsonb;

-- ============ Profit ============
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_cost numeric;
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost numeric, ADD COLUMN IF NOT EXISTS cost_override numeric;
CREATE TABLE ad_spend (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  day date NOT NULL,
  channel text NOT NULL DEFAULT 'meta',
  amount numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, day, channel)
);

-- ============ Billing ============
CREATE TABLE plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  price numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  interval text NOT NULL DEFAULT 'month',
  limits jsonb NOT NULL DEFAULT '{}', -- {stores, messages, aiReplies, users}
  features jsonb NOT NULL DEFAULT '[]',
  stripe_price_id text,
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0
);
INSERT INTO plans (id, name, price, limits, features, sort) VALUES
  ('trial', 'Free trial', 0, '{"stores":1,"messages":500,"aiReplies":200,"users":2}', '["14 days","All features"]', 0),
  ('starter', 'Starter', 19, '{"stores":1,"messages":3000,"aiReplies":1000,"users":3}', '["1 store","3,000 messages / month","Courier booking","Reports"]', 1),
  ('growth', 'Growth', 49, '{"stores":3,"messages":15000,"aiReplies":6000,"users":10}', '["3 stores","15,000 messages / month","Fraud protection","Profit dashboard","Automation rules"]', 2),
  ('pro', 'Pro', 129, '{"stores":10,"messages":60000,"aiReplies":25000,"users":30}', '["10 stores","60,000 messages / month","API & webhooks","Priority support"]', 3)
ON CONFLICT (id) DO NOTHING;
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS plan_status text NOT NULL DEFAULT 'active', -- trialing | active | past_due | canceled
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_until timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
ALTER TABLE usage_counters ADD COLUMN IF NOT EXISTS ai_replies int NOT NULL DEFAULT 0;

-- ============ Back-in-stock, reviews ============
CREATE TABLE stock_alerts (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_product_id bigint NOT NULL,
  variant_id bigint,
  phone_e164 text NOT NULL,
  customer_id bigint REFERENCES customers(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'waiting', -- waiting | sent | failed
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stock_alerts_unique_idx ON stock_alerts(store_id, shopify_product_id, COALESCE(variant_id, 0), phone_e164) WHERE status = 'waiting';

CREATE TABLE reviews (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id bigint REFERENCES orders(id) ON DELETE SET NULL,
  customer_id bigint REFERENCES customers(id) ON DELETE SET NULL,
  shopify_product_id bigint,
  customer_name text,
  rating int,
  body text,
  media jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending', -- requested | pending | published | hidden
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_store_idx ON reviews(store_id, created_at DESC);

-- ============ Inbox tools ============
CREATE TABLE saved_replies (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id bigint REFERENCES stores(id) ON DELETE CASCADE,
  title text NOT NULL,
  shortcut text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE conversation_notes (
  id bigserial PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS labels text[] NOT NULL DEFAULT '{}';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS language text;

-- ============ Automation rules ============
CREATE TABLE automation_rules (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger text NOT NULL, -- order.created | order.confirmed | order.cancelled | order.no_response | shipment.delivered | shipment.returned | shipment.failed
  conditions jsonb NOT NULL DEFAULT '[]', -- [{field, op, value}]
  steps jsonb NOT NULL DEFAULT '[]',      -- [{type, ...}]
  active boolean NOT NULL DEFAULT true,
  runs int NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automation_rules_trigger_idx ON automation_rules(store_id, trigger) WHERE active;

-- ============ Public API & outgoing webhooks ============
CREATE TABLE api_tokens (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{read,write}',
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_endpoints (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret_enc text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  last_status int,
  last_error text,
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
