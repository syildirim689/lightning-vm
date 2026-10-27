-- Notifications keep both languages, so the inbox follows the language the panel is shown in, not the one the
-- account had when the notification was written (notify.ts). Accounts can also come from single sign-on (OIDC, sso.ts).
ALTER TABLE notifications ADD COLUMN texts jsonb;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_source_check;
ALTER TABLE users ADD CONSTRAINT users_auth_source_check CHECK (auth_source IN ('local', 'ldap', 'oidc'));
