-- Customers' SSH public keys (not secret), injected through cloud-init.
CREATE TABLE ssh_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  public_key text NOT NULL CHECK (length(public_key) <= 16384),
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, fingerprint)
);

-- A server is the platform's record; the VM in VMware is found by vm_moref and by its name
-- "lvm-<id>", which makes a retried clone find an earlier one instead of creating a second VM.
-- Its vcpu/memory/disk, while not deleted, are the pool's reserved capacity.
CREATE TABLE servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  pool_id uuid NOT NULL REFERENCES resource_pools(id) ON DELETE RESTRICT,
  image_id uuid NOT NULL REFERENCES os_images(id) ON DELETE RESTRICT,
  package_id uuid REFERENCES packages(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  vcpu int NOT NULL CHECK (vcpu >= 1),
  memory_mb int NOT NULL CHECK (memory_mb >= 512),
  disk_gb int NOT NULL CHECK (disk_gb >= 1),
  price_monthly numeric(12,2) NOT NULL,
  currency char(3) NOT NULL,
  state text NOT NULL CHECK (state IN ('provisioning', 'ready', 'error', 'deleting', 'deleted', 'missing')),
  power_state text NOT NULL DEFAULT 'unknown' CHECK (power_state IN ('poweredOn', 'poweredOff', 'suspended', 'unknown')),
  guest_ready boolean NOT NULL DEFAULT false,
  vm_moref text,
  ssh_public_keys text[] NOT NULL DEFAULT '{}', -- copied at order time; public keys are not secret
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX servers_owner_idx ON servers (owner_id) WHERE state <> 'deleted';
CREATE INDEX servers_pool_idx ON servers (pool_id) WHERE state <> 'deleted';
CREATE UNIQUE INDEX servers_owner_name_key ON servers (owner_id, name) WHERE state <> 'deleted';

-- One address per live server; the unique index makes double allocation impossible.
CREATE TABLE ip_allocations (
  ip_pool_id uuid NOT NULL REFERENCES ip_pools(id) ON DELETE RESTRICT,
  address inet NOT NULL,
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (address),
  UNIQUE (server_id)
);

-- The operation is the durable source of truth for every server action. Redis/BullMQ only carries
-- the job id (= operation id); a lost queue entry is re-enqueued from here.
ALTER TABLE operations
  ADD COLUMN server_id uuid REFERENCES servers(id) ON DELETE CASCADE,
  ADD COLUMN owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN step text,
  ADD COLUMN attempts int NOT NULL DEFAULT 0,
  ADD COLUMN request_hash text,
  ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN deadline_at timestamptz,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN error_detail text;
ALTER TABLE operations DROP CONSTRAINT operations_status_check;
ALTER TABLE operations ADD CONSTRAINT operations_status_check CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled'));
ALTER TABLE operations ADD CONSTRAINT operations_kind_check CHECK (kind IN ('create', 'delete', 'power_on', 'shutdown', 'power_off', 'reset'));
ALTER TABLE operations ALTER COLUMN id SET DEFAULT gen_random_uuid();
CREATE INDEX operations_server_idx ON operations (server_id, created_at DESC);
CREATE INDEX operations_open_idx ON operations (status) WHERE status IN ('pending', 'running');
-- At most one unfinished operation per server: actions never race each other on one VM.
CREATE UNIQUE INDEX operations_one_open_per_server ON operations (server_id) WHERE status IN ('pending', 'running');

-- What reconciliation saw when comparing the platform with VMware.
CREATE TABLE reconciliation_findings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES vmware_connections(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('vm_missing', 'orphan_vm', 'power_drift')),
  server_id uuid REFERENCES servers(id) ON DELETE CASCADE,
  vm_moref text,
  detail jsonb NOT NULL DEFAULT '{}',
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX reconciliation_open_key ON reconciliation_findings (connection_id, kind, COALESCE(server_id::text, vm_moref)) WHERE resolved_at IS NULL;
