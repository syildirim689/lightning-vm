-- Quiet hours (quiet-hours.ts): {start, end, tz} or NULL.
ALTER TABLE users ADD COLUMN quiet_hours jsonb;
