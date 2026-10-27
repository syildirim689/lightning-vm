-- A server ordered as a copy of another: its VM is cloned from that server's VM (disk included) instead of the
-- image's template; cloud-init then gives the copy its own name, address and keys.
ALTER TABLE servers ADD COLUMN clone_from_moref text;
