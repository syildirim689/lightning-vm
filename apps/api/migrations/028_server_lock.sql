-- Delete protection: a locked server cannot be deleted, powered off, reset or reverted to a snapshot by anyone
-- until it is unlocked (servers.ts startOperation).
ALTER TABLE servers ADD COLUMN locked boolean NOT NULL DEFAULT false;
