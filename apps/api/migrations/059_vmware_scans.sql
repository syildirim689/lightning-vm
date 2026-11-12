-- Network discovery of ESXi / vCenter endpoints: scans of IP blocks, what answered, and endpoints an admin chose to ignore.
CREATE TABLE vmware_scans (
  id uuid PRIMARY KEY,
  targets text NOT NULL CHECK (length(targets) <= 4000),
  port int NOT NULL CHECK (port BETWEEN 1 AND 65535),
  auto boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('running', 'done', 'failed', 'cancelled')),
  total int NOT NULL,
  scanned int NOT NULL DEFAULT 0,
  found int NOT NULL DEFAULT 0,   -- answered as ESXi or vCenter
  other int NOT NULL DEFAULT 0,   -- another HTTPS service
  closed int NOT NULL DEFAULT 0,
  silent int NOT NULL DEFAULT 0,
  blocked int NOT NULL DEFAULT 0,
  error_code text,
  started_by uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
-- One scan at a time, across API instances too.
CREATE UNIQUE INDEX vmware_scans_one_running ON vmware_scans ((true)) WHERE status = 'running';
CREATE INDEX vmware_scans_started ON vmware_scans (started_at DESC);

CREATE TABLE vmware_scan_hits (
  scan_id uuid NOT NULL REFERENCES vmware_scans(id) ON DELETE CASCADE,
  address text NOT NULL,
  state text NOT NULL CHECK (state IN ('vsphere', 'https')),
  hostname text,
  product jsonb,
  certificate jsonb,
  PRIMARY KEY (scan_id, address)
);

-- Key: the endpoint's instance UUID, or its address when it has none.
CREATE TABLE vmware_scan_ignored (
  key text PRIMARY KEY CHECK (length(key) <= 200),
  label text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
