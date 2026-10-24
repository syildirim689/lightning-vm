-- Sessions move to better-auth. Users stay in "users" (every foreign key keeps working); better-auth's
-- session, account, verification and passkey tables are added under auth_* names.

-- better-auth looks users up with email = lower(input); the unique index already compares lower(email).
UPDATE users SET email = lower(email) WHERE email <> lower(email);

ALTER TABLE users
  ADD COLUMN name text NOT NULL DEFAULT '',
  ADD COLUMN email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN image text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN banned boolean DEFAULT false,
  ADD COLUMN ban_reason text,
  ADD COLUMN ban_expires timestamptz,
  ALTER COLUMN role SET DEFAULT 'user';

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  impersonated_by text
);
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions (user_id);

-- Passwords live here (provider_id 'credential', account_id = the user id); the scrypt format is unchanged.
CREATE TABLE auth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);
CREATE INDEX auth_accounts_user_id_idx ON auth_accounts (user_id);
INSERT INTO auth_accounts (account_id, provider_id, user_id, password, updated_at)
  SELECT id::text, 'credential', id, password_hash, now() FROM users WHERE password_hash IS NOT NULL;
ALTER TABLE users DROP COLUMN password_hash;

CREATE TABLE auth_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_verifications_identifier_idx ON auth_verifications (identifier);

CREATE TABLE auth_passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  public_key text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL,
  counter integer NOT NULL,
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  transports text,
  created_at timestamptz,
  aaguid text
);
CREATE INDEX auth_passkeys_user_id_idx ON auth_passkeys (user_id);
CREATE INDEX auth_passkeys_credential_id_idx ON auth_passkeys (credential_id);

-- Old sessions cannot be converted (only their hash was stored): everyone signs in again once.
DROP TABLE sessions;
