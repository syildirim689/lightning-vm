-- Energy: host power every few minutes (measured where the host reports it, else estimated from a power
-- profile and CPU use), each server's estimated share, and per-host profiles for the estimate.
CREATE TABLE power_samples (
  connection_id uuid NOT NULL REFERENCES vmware_connections(id) ON DELETE CASCADE,
  host_moref text NOT NULL,
  host_name text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now(),
  watts numeric(10,2) NOT NULL CHECK (watts >= 0),
  minutes numeric(6,2) NOT NULL CHECK (minutes > 0),  -- time this sample stands for (gap to the previous one, capped)
  source text NOT NULL CHECK (source IN ('measured', 'estimated')),
  cpu_util numeric(5,4),
  PRIMARY KEY (connection_id, host_moref, at)
);
CREATE INDEX power_samples_at_idx ON power_samples (at);

CREATE TABLE power_server_samples (
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  watts numeric(10,2) NOT NULL CHECK (watts >= 0),
  minutes numeric(6,2) NOT NULL CHECK (minutes > 0),
  PRIMARY KEY (server_id, at)
);
CREATE INDEX power_server_samples_at_idx ON power_server_samples (at);

CREATE TABLE power_host_profiles (
  connection_id uuid NOT NULL REFERENCES vmware_connections(id) ON DELETE CASCADE,
  host_moref text NOT NULL,
  idle_watts integer NOT NULL CHECK (idle_watts BETWEEN 0 AND 20000),
  max_watts integer NOT NULL CHECK (max_watts BETWEEN 1 AND 20000),
  PRIMARY KEY (connection_id, host_moref),
  CHECK (max_watts >= idle_watts)
);
