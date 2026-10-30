-- Commands an administrator shares with everyone (settings.manage); the others stay their owner's own.
ALTER TABLE console_snippets ADD COLUMN shared boolean NOT NULL DEFAULT false;
CREATE INDEX console_snippets_shared ON console_snippets (name) WHERE shared;
