-- WhatsApp numbers can be official Cloud API ("cloud") or a QR-linked WhatsApp Web session ("gateway").
ALTER TABLE whatsapp_numbers ADD COLUMN provider text NOT NULL DEFAULT 'cloud';
ALTER TABLE whatsapp_numbers ADD COLUMN gateway_session text UNIQUE;
ALTER TABLE whatsapp_numbers ALTER COLUMN token_enc DROP NOT NULL;

-- Shopify product catalog (images for messages, campaigns, inbox and the AI agent).
CREATE TABLE products (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_product_id bigint NOT NULL,
  title text NOT NULL,
  handle text,
  status text,
  product_type text,
  vendor text,
  tags text[] NOT NULL DEFAULT '{}',
  image_url text,
  images jsonb NOT NULL DEFAULT '[]',
  price_min numeric,
  price_max numeric,
  currency text,
  inventory int,
  variants jsonb NOT NULL DEFAULT '[]',
  online_url text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, shopify_product_id)
);
CREATE INDEX products_store_title_idx ON products(store_id, lower(title));

-- Personal WhatsApp number for store owners (used for their daily report).
ALTER TABLE users ADD COLUMN phone_e164 text;
ALTER TABLE owner_contacts ADD COLUMN user_id bigint REFERENCES users(id) ON DELETE CASCADE;

-- Platform-wide report for the super admin.
ALTER TABLE reports ALTER COLUMN account_id DROP NOT NULL;
CREATE TABLE platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
