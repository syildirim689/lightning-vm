-- Snapshots of a server's VM (without memory): taken, reverted to and removed as ordinary operations, so the task
-- list, history, retries and notifications work as for power actions. params holds the snapshot's name or id.
ALTER TABLE operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE operations ADD CONSTRAINT operations_kind_check
  CHECK (kind IN ('create', 'delete', 'power_on', 'shutdown', 'power_off', 'reset', 'snapshot_create', 'snapshot_revert', 'snapshot_delete'));
ALTER TABLE operations ADD COLUMN params jsonb NOT NULL DEFAULT '{}';
