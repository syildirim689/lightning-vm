-- Personal API tokens: "Authorization: Bearer lvm_…" acts as the person who made it (read-only or full), until it
-- expires or is removed. Only a SHA-256 of the token is kept; the token itself is shown once.
CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  token_hash text NOT NULL UNIQUE,
  hint text NOT NULL, -- the last four characters, to tell tokens apart
  scope text NOT NULL CHECK (scope IN ('read', 'write')),
  expires_at timestamptz,
  last_used_at timestamptz,
  last_used_ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_user ON api_tokens (user_id);

-- Webhooks: the events a person is notified about, also POSTed (signed) to their own HTTPS address.
CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url text NOT NULL,
  description text NOT NULL DEFAULT '',
  events text[] NOT NULL, -- notification event keys, or '*' for all of them
  secret_enc text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  failures int NOT NULL DEFAULT 0, -- consecutive failed deliveries; many in a row switch the webhook off
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_user ON webhooks (user_id);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY,
  webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  response_code int,
  error text,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at DESC);
