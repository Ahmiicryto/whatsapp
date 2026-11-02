-- Warehouse scanning, finance overview, Meta Ads spend sync and performance indexes.

ALTER TABLE shipments ADD COLUMN IF NOT EXISTS return_received_at timestamptz;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

CREATE TABLE parcel_scans (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shipment_id bigint REFERENCES shipments(id) ON DELETE SET NULL,
  order_id bigint REFERENCES orders(id) ON DELETE SET NULL,
  code text NOT NULL,
  action text NOT NULL, -- lookup | dispatched | delivered | return_received
  result text NOT NULL DEFAULT 'ok', -- ok | already | not_found | error
  user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parcel_scans_store_idx ON parcel_scans(store_id, created_at DESC);

-- Ad accounts whose spend is pulled automatically (Meta Marketing API)
CREATE TABLE ad_accounts (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'meta',
  account_id text NOT NULL,
  name text,
  currency text,
  fx_rate numeric NOT NULL DEFAULT 1, -- multiply ad spend by this to get the store currency
  token_enc text NOT NULL,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, provider, account_id)
);
ALTER TABLE ad_spend
  ADD COLUMN IF NOT EXISTS impressions bigint,
  ADD COLUMN IF NOT EXISTS clicks bigint,
  ADD COLUMN IF NOT EXISTS purchases int,
  ADD COLUMN IF NOT EXISTS purchase_value numeric,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'; -- manual | csv | meta_api

-- Performance: indexes for the hottest list/report queries
CREATE INDEX IF NOT EXISTS shipments_store_status_idx ON shipments(store_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS shipments_cod_due_idx ON shipments(store_id) WHERE status = 'delivered' AND cod_settled_at IS NULL;
CREATE INDEX IF NOT EXISTS orders_store_updated_idx ON orders(store_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS orders_store_confirmed_idx ON orders(store_id, confirmed_at) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS orders_attention_idx ON orders(store_id) WHERE needs_attention;
CREATE INDEX IF NOT EXISTS conversations_human_idx ON conversations(store_id, last_message_at DESC) WHERE needs_human;
CREATE INDEX IF NOT EXISTS order_items_store_product_idx ON order_items(store_id, product_id, order_id);
CREATE INDEX IF NOT EXISTS shipments_tracking_lower_idx ON shipments(store_id, lower(tracking_number));
CREATE INDEX IF NOT EXISTS orders_store_name_idx ON orders(store_id, name);
