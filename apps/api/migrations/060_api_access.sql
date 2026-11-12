-- API access for integrations: a token may be narrowed to some of its owner's permissions and to some addresses,
-- and requests made with tokens are logged (how long is set in Settings → API).
ALTER TABLE api_tokens ADD COLUMN permissions text[];                     -- NULL: all of the owner's permissions
ALTER TABLE api_tokens ADD COLUMN allowed_ips text[] NOT NULL DEFAULT '{}'; -- empty: any address the role allows

CREATE TABLE api_request_log (
  id bigserial PRIMARY KEY,
  token_id uuid,           -- kept after the token is removed, so the log still says which one it was
  token_name text,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  method text NOT NULL,
  route text NOT NULL,     -- the route pattern (/servers/:id), not the address with its values
  path text NOT NULL,
  status int NOT NULL,
  duration_ms int NOT NULL,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_request_log_at ON api_request_log (created_at DESC);
CREATE INDEX api_request_log_token ON api_request_log (token_id, created_at DESC);
