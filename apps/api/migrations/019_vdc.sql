-- Virtual data centers: a customer's fixed allocation (vCPU, memory, disk, servers) in one pool for a monthly
-- price. Servers inside it carry no price of their own and do not count against the user's quota; the pool
-- counts the allocation as reserved instead of its servers.
CREATE TABLE vdcs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  pool_id uuid NOT NULL REFERENCES resource_pools(id) ON DELETE RESTRICT,
  vcpu integer NOT NULL CHECK (vcpu BETWEEN 1 AND 100000),
  memory_mb integer NOT NULL CHECK (memory_mb BETWEEN 512 AND 1073741824),
  disk_gb integer NOT NULL CHECK (disk_gb BETWEEN 10 AND 1073741824),
  max_servers integer NOT NULL CHECK (max_servers BETWEEN 1 AND 10000),
  price_monthly numeric(12,2) NOT NULL DEFAULT 0 CHECK (price_monthly >= 0),
  currency text NOT NULL DEFAULT 'EUR' CHECK (currency ~ '^[A-Z]{3}$'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
ALTER TABLE servers ADD COLUMN vdc_id uuid REFERENCES vdcs(id) ON DELETE RESTRICT;
CREATE INDEX servers_vdc_idx ON servers (vdc_id) WHERE state <> 'deleted';
