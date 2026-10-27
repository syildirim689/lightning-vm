-- Servers sold by an outside billing system (WHMCS, WISECP through external.ts): which one, and its service id there.
-- They are never billed by the panel.
ALTER TABLE servers ADD COLUMN external_source text, ADD COLUMN external_ref text;
CREATE UNIQUE INDEX servers_external_ref ON servers (external_source, external_ref) WHERE external_ref IS NOT NULL AND state <> 'deleted';
