CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (length(email) <= 254),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'user')),
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('tr', 'en')),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- Only a SHA-256 of the session token is stored; the token itself lives in the cookie.
CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip inet,
  user_agent text
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES ('registration_open', 'false');

CREATE TABLE setup_state (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  bootstrap_token_hash bytea,
  bootstrap_expires_at timestamptz,
  admin_created_at timestamptz,
  completed_at timestamptz
);
INSERT INTO setup_state DEFAULT VALUES;

ALTER TABLE audit_events
  ADD COLUMN outcome text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure', 'denied')),
  ADD COLUMN ip inet,
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
CREATE INDEX audit_events_created_at_idx ON audit_events (created_at);
CREATE INDEX audit_events_actor_id_idx ON audit_events (actor_id);
