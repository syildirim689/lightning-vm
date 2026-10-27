-- Staff move a server to another host (vMotion) or datastore (Storage vMotion), one by one or a whole host at once
-- before its maintenance (placement.ts). The move is an operation like the others.
ALTER TABLE operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE operations ADD CONSTRAINT operations_kind_check
  CHECK (kind IN ('create', 'delete', 'power_on', 'shutdown', 'power_off', 'reset', 'snapshot_create', 'snapshot_revert', 'snapshot_delete', 'resize', 'reinstall',
    'backup_create', 'backup_restore', 'backup_delete', 'migrate'));
