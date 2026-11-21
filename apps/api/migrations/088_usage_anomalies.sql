-- Usage anomalies: a server whose CPU or network use departs sharply from its own recent baseline (the worker's
-- anomalies.mjs judges, hourly). A finding stays open while its numbers hold and is closed by the run that no longer
-- finds it; detail keeps the numbers it was opened on (recent, usual, spread, z-score, how much history).
CREATE TABLE usage_anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('cpu', 'network')),
  direction text NOT NULL CHECK (direction IN ('high', 'low')),
  detail jsonb NOT NULL DEFAULT '{}',
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
-- One open finding per server and metric.
CREATE UNIQUE INDEX usage_anomalies_open_key ON usage_anomalies (server_id, metric) WHERE resolved_at IS NULL;

-- CPU per server and hour (UTC), rolled up from server_cpu_samples, which are only kept 14 days: weeks of history for
-- the rules that need a weekly pattern, at 24 rows per server and day instead of 288.
CREATE TABLE server_cpu_hourly (
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  hour timestamptz NOT NULL,
  avg_pct numeric(6,2) NOT NULL,
  max_pct numeric(6,2) NOT NULL,
  samples int NOT NULL,
  PRIMARY KEY (server_id, hour)
);
CREATE INDEX server_cpu_hourly_hour ON server_cpu_hourly (hour);
-- The samples arrive in time order: a block range index finds "since the last roll-up" without reading the table.
CREATE INDEX server_cpu_samples_at ON server_cpu_samples USING brin (at);
