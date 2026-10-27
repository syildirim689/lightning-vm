-- Sign-in methods (sign-in-methods.ts): a user name to sign in with (better-auth's username plugin, lowercase),
-- and accounts that came from a social provider (Google, GitHub...).
ALTER TABLE users ADD COLUMN username text UNIQUE CHECK (username IS NULL OR username ~ '^[a-z0-9][a-z0-9._-]{2,29}$');
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_source_check;
ALTER TABLE users ADD CONSTRAINT users_auth_source_check CHECK (auth_source IN ('local', 'ldap', 'oidc', 'social'));
