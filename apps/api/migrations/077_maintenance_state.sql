-- What the installer leaves for the application about the state of the installation itself. One row so far:
-- 'restore_hold', set by a restore of an older backup (scripts/install.sh). While it is there the panel acts on nothing
-- by itself (no operation is started or recovered, no schedule, due deletion or billing run) and starts nothing on
-- request, until staff have looked at what changed since the backup and release it (Settings, or cli release-restore-hold).
CREATE TABLE maintenance_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
