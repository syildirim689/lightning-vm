-- Abuse monitoring: risky ports found open on servers, and servers whose CPU stays near full for hours
-- (a cryptocurrency-mining suspicion). A finding stays open while the condition lasts; staff can acknowledge it.
CREATE TABLE abuse_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('port', 'cpu')),
  address inet,
  port integer CHECK (port BETWEEN 1 AND 65535),
  detail jsonb NOT NULL DEFAULT '{}',
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  note text NOT NULL DEFAULT ''
);
-- One open finding per server, kind, address and port.
CREATE UNIQUE INDEX abuse_findings_open_key ON abuse_findings (server_id, kind, COALESCE(host(address), ''), COALESCE(port, 0)) WHERE resolved_at IS NULL;

-- A server's CPU use (percent of its vCPUs), stored with each energy sample.
CREATE TABLE server_cpu_samples (
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  cpu_pct numeric(6,2) NOT NULL CHECK (cpu_pct >= 0),
  PRIMARY KEY (server_id, at)
);
