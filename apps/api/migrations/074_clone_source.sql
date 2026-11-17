-- A copy order is bound to its source server, not only to the hypervisor's VM id noted at order time (042): the worker
-- reads the source again when it builds (still there, still the copy owner's, still that VM), and a server that is the
-- source of a copy not yet built is neither handed over nor deleted.
ALTER TABLE servers ADD COLUMN clone_from_server_id uuid REFERENCES servers(id) ON DELETE SET NULL;
CREATE INDEX servers_clone_source ON servers (clone_from_server_id) WHERE clone_from_server_id IS NOT NULL;
-- Copies ordered before this and not built yet: bound to the orderer's own server that has that VM in the same
-- location. One that finds no such server stays unbound and fails when built (CLONE_SOURCE_GONE).
UPDATE servers c SET clone_from_server_id = s.id FROM servers s
  WHERE c.clone_from_moref IS NOT NULL AND c.vm_moref IS NULL AND c.state = 'provisioning'
    AND s.vm_moref = c.clone_from_moref AND s.owner_id = c.owner_id AND s.pool_id = c.pool_id AND s.state = 'ready' AND s.id <> c.id;
