-- Operating system updates inside customers' servers. A small reporter in the server (guest-updates-script.ts)
-- posts what waits; the panel keeps the last report, the owner's policy and one requested action per server.
CREATE TABLE IF NOT EXISTS server_updates (
  server_id uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  -- notify: only tell the owner; security: install security updates by itself; all: install everything by itself
  policy text NOT NULL DEFAULT 'notify' CHECK (policy IN ('notify', 'security', 'all')),
  auto_reboot boolean NOT NULL DEFAULT false,
  reboot_hour smallint NOT NULL DEFAULT 4 CHECK (reboot_hour BETWEEN 0 AND 23),
  pending_action text CHECK (pending_action IN ('security', 'upgrade', 'reboot')),
  action_at timestamptz,
  reported_at timestamptz,
  os text,
  manager text,
  total integer NOT NULL DEFAULT 0,
  security integer NOT NULL DEFAULT 0,
  reboot_required boolean NOT NULL DEFAULT false,
  packages jsonb NOT NULL DEFAULT '[]',
  last_run jsonb,
  notified_security_at timestamptz,
  notified_reboot_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
