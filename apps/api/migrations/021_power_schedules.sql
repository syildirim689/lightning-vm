-- A server's recurring power actions (start in the morning, shut down in the evening), at a local time on
-- chosen ISO weekdays (1 = Monday). The API's scheduler starts an ordinary operation for each run.
CREATE TABLE power_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('power_on', 'shutdown')),
  days smallint[] NOT NULL CHECK (cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  at_time time NOT NULL,
  timezone text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_result text, -- started | skipped_state | skipped_busy | skipped_disabled | failed
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX power_schedules_server_idx ON power_schedules (server_id);
