-- Extra disks (disks.ts): more disks on a server beside its system disk, sold per GB and month where the location sets
-- a price (resource_pools.extra_disk_price_gb; empty: not sold). Adding and removing one are operations.
ALTER TABLE resource_pools ADD COLUMN extra_disk_price_gb numeric(12,4) CHECK (extra_disk_price_gb >= 0);
CREATE TABLE server_disks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  size_gb int NOT NULL CHECK (size_gb BETWEEN 1 AND 65536),
  price_monthly numeric(12,2) NOT NULL DEFAULT 0,
  device_key int,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'removing', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX server_disks_server ON server_disks (server_id);
ALTER TABLE operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE operations ADD CONSTRAINT operations_kind_check
  CHECK (kind IN ('create', 'delete', 'power_on', 'shutdown', 'power_off', 'reset', 'snapshot_create', 'snapshot_revert', 'snapshot_delete', 'resize', 'reinstall',
    'backup_create', 'backup_restore', 'backup_delete', 'migrate', 'disk_add', 'disk_remove'));
