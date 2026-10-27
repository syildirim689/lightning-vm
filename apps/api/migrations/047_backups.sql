-- Backups (backups.ts, worker operations): a copy of a server's disk on its location's backup datastore, taken while it
-- runs (under a short snapshot), restored over the disk while it is off. Taken by hand or by a schedule (power_schedules
-- action 'backup' keeps the newest `keep` scheduled ones). A server's backups go with it when it is deleted.
ALTER TABLE resource_pools ADD COLUMN backup_datastore_moref text;
CREATE TABLE backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES vmware_connections(id) ON DELETE CASCADE,
  datastore_moref text NOT NULL,
  path text NOT NULL, -- <server id>/<backup id>.vmdk under lightning-backups/
  kind text NOT NULL CHECK (kind IN ('manual', 'scheduled')),
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ready', 'failed', 'deleted')),
  size_gb int,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX backups_server ON backups (server_id, created_at DESC) WHERE status <> 'deleted';
ALTER TABLE operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE operations ADD CONSTRAINT operations_kind_check
  CHECK (kind IN ('create', 'delete', 'power_on', 'shutdown', 'power_off', 'reset', 'snapshot_create', 'snapshot_revert', 'snapshot_delete', 'resize', 'reinstall',
    'backup_create', 'backup_restore', 'backup_delete'));
ALTER TABLE power_schedules DROP CONSTRAINT power_schedules_action_check;
ALTER TABLE power_schedules ADD CONSTRAINT power_schedules_action_check CHECK (action IN ('power_on', 'shutdown', 'snapshot', 'backup'));
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT p FROM unnest(permissions || ARRAY['server.backups']) p ORDER BY p) WHERE 'server.power' = ANY(permissions);
