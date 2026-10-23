CREATE TABLE IF NOT EXISTS worker_heartbeats (
  name text PRIMARY KEY,
  last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operations (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  idempotency_key text NOT NULL UNIQUE,
  provider_task_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid,
  action text NOT NULL,
  resource_id text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
