-- Where an account signs in: the panel's own password (local) or a directory (ldap.ts). Directory accounts
-- cannot change or reset their password in the panel; external_id is their DN.
ALTER TABLE users ADD COLUMN auth_source text NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local', 'ldap'));
ALTER TABLE users ADD COLUMN external_id text;
