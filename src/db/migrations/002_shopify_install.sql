-- Installs that start from Shopify (install link / Shopify admin) may not know the portal account yet.
ALTER TABLE oauth_states ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE oauth_states ALTER COLUMN account_id DROP NOT NULL;

-- A finished Shopify install waiting for someone to sign in and claim it.
CREATE TABLE pending_installs (
  token text PRIMARY KEY,
  shop text NOT NULL,
  access_token_enc text NOT NULL,
  scope text,
  created_at timestamptz NOT NULL DEFAULT now()
);
