-- Automatic snapshots on a schedule (schedules.ts): "snapshot" takes one named "auto …" and keeps the newest `keep`
-- automatic ones; when full it first removes the oldest automatic one and stays pending until it can take the new one.
ALTER TABLE power_schedules DROP CONSTRAINT power_schedules_action_check;
ALTER TABLE power_schedules ADD CONSTRAINT power_schedules_action_check CHECK (action IN ('power_on', 'shutdown', 'snapshot'));
ALTER TABLE power_schedules ADD COLUMN keep smallint CHECK (keep BETWEEN 1 AND 32), ADD COLUMN pending_since timestamptz;
