-- When the source of a directory (LDAP) or single sign-on account last confirmed the account: its last sign-in the
-- directory or provider accepted, or the last time the directory still listed it when one of its API tokens was used
-- (directory-signin.ts, reconfirmDirectory). A personal API token of such an account is accepted only while this is
-- recent (DIRECTORY_TOKEN_DAYS, default 30; ldap.ts, tokenAsleep): the panel is not told when a person leaves the
-- directory, and a token needs no sign-in. NULL: not confirmed (the directory no longer lists the account).
-- The accounts that exist now have no such moment on record: they count as confirmed at this upgrade, so their tokens
-- keep working and the limit runs from here.
ALTER TABLE users ADD COLUMN source_confirmed_at timestamptz;
UPDATE users SET source_confirmed_at = now() WHERE auth_source IN ('ldap', 'oidc');
