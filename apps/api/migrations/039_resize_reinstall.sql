-- Changing a server's size (vCPU, memory, a larger disk) and installing another image on it are operations like the
-- others (one at a time per server, retried, listed). Customers get both where they already act on their servers.
ALTER TABLE operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE operations ADD CONSTRAINT operations_kind_check
  CHECK (kind IN ('create', 'delete', 'power_on', 'shutdown', 'power_off', 'reset', 'snapshot_create', 'snapshot_revert', 'snapshot_delete', 'resize', 'reinstall'));
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT p FROM unnest(permissions || ARRAY['server.resize', 'server.reinstall']) p ORDER BY p)
  WHERE 'server.power' = ANY(permissions);
