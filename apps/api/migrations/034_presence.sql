-- When each session was last used and from where, and when each person was last seen (presence.ts).
ALTER TABLE auth_sessions ADD COLUMN last_active_at timestamptz, ADD COLUMN last_ip inet;
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
