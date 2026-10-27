-- Personal images (images.ts): a customer's server saved as a template; only its owner sees and orders it.
ALTER TABLE os_images ADD COLUMN owner_id uuid REFERENCES users(id) ON DELETE CASCADE, ADD COLUMN source_server_id uuid REFERENCES servers(id) ON DELETE SET NULL;
CREATE INDEX os_images_owner ON os_images (owner_id) WHERE owner_id IS NOT NULL;
ALTER TABLE operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE operations ADD CONSTRAINT operations_kind_check
  CHECK (kind IN ('create', 'delete', 'power_on', 'shutdown', 'power_off', 'reset', 'snapshot_create', 'snapshot_revert', 'snapshot_delete', 'resize', 'reinstall',
    'backup_create', 'backup_restore', 'backup_delete', 'migrate', 'disk_add', 'disk_remove', 'nic_add', 'nic_remove', 'image_create'));
