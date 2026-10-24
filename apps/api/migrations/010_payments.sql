-- Payment methods (apps/api/src/payments.ts): one row per provider the admin configured. Live and test
-- credentials are stored separately, each encrypted as one JSON document; *_version changes with every
-- credential change, and a check result counts for activation only if it was made on that version.
CREATE TABLE payment_gateways (
  id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'test' CHECK (mode IN ('live', 'test')),
  label text NOT NULL DEFAULT '',
  live_enc text,
  test_enc text,
  live_version integer NOT NULL DEFAULT 0,
  test_version integer NOT NULL DEFAULT 0,
  -- {status, message, unverified[], at, version}
  live_check jsonb,
  test_check jsonb,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
