-- Hetzner-style firewalls (apps/api/src/firewalls.ts): a named rule list owned by a customer, attached to
-- up to 5 of their servers. The VMware adapter enforces it as a distributed-port traffic filter.
CREATE TABLE firewalls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  -- [{direction: in|out, protocol: tcp|udp|icmp|esp|gre, port: "22" | "8000-8100" | null, ips: [cidr], description}]
  rules jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

CREATE TABLE firewall_servers (
  firewall_id uuid NOT NULL REFERENCES firewalls(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (firewall_id, server_id)
);
CREATE INDEX firewall_servers_server_idx ON firewall_servers (server_id);

-- Every change bumps firewall_version; the worker applies the current rules and records the version it
-- applied, so a lost or failed job is visible and recoverable (applied < version).
ALTER TABLE servers
  ADD COLUMN firewall_version integer NOT NULL DEFAULT 0,
  ADD COLUMN firewall_applied_version integer NOT NULL DEFAULT 0,
  ADD COLUMN firewall_error text,
  ADD COLUMN firewall_applied_at timestamptz;

UPDATE roles SET permissions = array_append(permissions, 'firewalls.manage') WHERE key IN ('user', 'operator', 'support') AND NOT 'firewalls.manage' = ANY(permissions);
