-- Deletion with a grace period (servers.ts): the server is shut down and waits until delete_at, when the scheduler deletes it;
-- until then its owner can take it back. Renewals wait meanwhile; hourly hours are charged only if it is taken back.
ALTER TABLE servers ADD COLUMN delete_at timestamptz;
CREATE INDEX servers_delete_at ON servers (delete_at) WHERE delete_at IS NOT NULL;
