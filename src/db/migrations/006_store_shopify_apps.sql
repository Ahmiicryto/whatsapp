-- A store can use its own Shopify app (Client ID + secret). Needed because Shopify apps with
-- custom distribution can only be installed on the one store they were created for.
CREATE TABLE shopify_apps (
  id bigserial PRIMARY KEY,
  account_id bigint REFERENCES accounts(id) ON DELETE CASCADE,
  shop text NOT NULL UNIQUE,
  client_id text NOT NULL,
  client_secret_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS app_id bigint REFERENCES shopify_apps(id) ON DELETE CASCADE;
ALTER TABLE pending_installs ADD COLUMN IF NOT EXISTS app_id bigint REFERENCES shopify_apps(id) ON DELETE SET NULL;
