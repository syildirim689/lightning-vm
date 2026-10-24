-- Applications installed on a new server by cloud-init (applications.ts): cPanel, Plesk or a custom script.
-- Licenses that are keys (Plesk) come from a pool the admin fills; each is given to one server.
CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
  kind text NOT NULL CHECK (kind IN ('cpanel', 'plesk', 'custom')),
  description text NOT NULL DEFAULT '',
  -- Shell script run as root after the first boot; {LICENSE}, {HOSTNAME} and {IP} are filled in.
  script text NOT NULL CHECK (length(script) BETWEEN 1 AND 20000),
  license_mode text NOT NULL DEFAULT 'none' CHECK (license_mode IN ('none', 'pool')),
  min_memory_mb integer NOT NULL DEFAULT 1024,
  min_disk_gb integer NOT NULL DEFAULT 20,
  price_monthly numeric(10, 2) NOT NULL DEFAULT 0 CHECK (price_monthly >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE application_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  key_enc text NOT NULL,
  key_hint text NOT NULL,          -- last characters, to tell keys apart without showing them
  server_id uuid REFERENCES servers(id) ON DELETE SET NULL,
  assigned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_licenses_free ON application_licenses (application_id) WHERE server_id IS NULL;

-- The installation on a server: the rendered script (encrypted: it may hold a license key), a one-time token
-- the guest reports back with, and what it reported.
ALTER TABLE servers
  ADD COLUMN application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  ADD COLUMN app_script_enc text,
  ADD COLUMN app_token_hash text,
  ADD COLUMN app_state text CHECK (app_state IN ('pending', 'installing', 'installed', 'failed')),
  ADD COLUMN app_message text,
  ADD COLUMN app_updated_at timestamptz;
