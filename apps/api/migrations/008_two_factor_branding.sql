-- better-auth two-factor (TOTP, SMS/e-mail codes, backup codes), phone number and last-login-method plugins;
-- panel branding, mail, captcha and SMS settings; notifications.

ALTER TABLE users
  ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN last_login_method text,
  ADD COLUMN phone_number text,
  ADD COLUMN phone_number_verified boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX users_phone_number_key ON users (phone_number) WHERE phone_number IS NOT NULL;

-- secret and backup_codes are encrypted by better-auth with its secret before they are stored.
CREATE TABLE auth_two_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret text NOT NULL,
  backup_codes text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified boolean DEFAULT true,
  failed_verification_count integer DEFAULT 0,
  locked_until timestamptz
);
CREATE INDEX auth_two_factors_user_id_idx ON auth_two_factors (user_id);
CREATE INDEX auth_two_factors_secret_idx ON auth_two_factors (secret);

-- Name, accent colour, logo and favicon shown on every page, including sign-in. Images are small data URLs.
INSERT INTO settings (key, value) VALUES ('branding', '{}') ON CONFLICT (key) DO NOTHING;

-- Notifications (apps/api/src/notify.ts): the in-app inbox, each user's channel choices within the admin's
-- policy (settings key 'notifications'), and browser push subscriptions (Web Push).
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  title text NOT NULL,
  body text NOT NULL,
  link text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC);

CREATE TABLE notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event text NOT NULL,
  channels text[] NOT NULL,
  PRIMARY KEY (user_id, event)
);

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- Roles and permissions (apps/api/src/rbac.ts). users.role holds one or more role keys, comma-separated
-- (better-auth's format). Per-user overrides add or remove single permissions on top of the roles.
CREATE TABLE roles (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_-]{1,31}$'),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  permissions text[] NOT NULL DEFAULT '{}',
  builtin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO roles (key, name, description, permissions, builtin) VALUES
  ('admin', 'Administrator', 'Everything, including roles and settings.', '{*}', true),
  ('user', 'Customer', 'Orders and manages their own servers.', '{servers.create}', true),
  ('operator', 'Operator', 'Runs the infrastructure: all servers, operations, VMware and capacity.',
    '{dashboard.view,servers.view_all,servers.manage_all,servers.create,operations.retry,reconcile.run,consoles.any,vmware.view,catalog.view,system.view}', true),
  ('support', 'Support', 'Helps customers: sees users and servers, can sign in as a customer.',
    '{dashboard.view,users.view,users.sessions,users.impersonate,servers.view_all,servers.create,audit.view}', true),
  ('auditor', 'Auditor', 'Read-only view of everything, including the audit log.',
    '{dashboard.view,servers.view_all,catalog.view,vmware.view,users.view,system.view,settings.view,audit.view}', true);

-- users.role was limited to 'admin' | 'user'; it now holds one or more role keys from the roles table.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_format CHECK (role ~ '^[a-z][a-z0-9_-]{1,31}(,[a-z][a-z0-9_-]{1,31})*$');

CREATE TABLE user_permission_overrides (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
  PRIMARY KEY (user_id, permission)
);

-- VMware version compatibility (apps/api/src/vmware.ts): an optional pinned API version, how new servers get
-- their cloud-init data, and what discovery concluded the endpoint supports.
ALTER TABLE vmware_connections
  ADD COLUMN api_version text,
  ADD COLUMN customization text NOT NULL DEFAULT 'auto' CHECK (customization IN ('auto', 'cloudinit', 'guestinfo')),
  ADD COLUMN compat jsonb;
