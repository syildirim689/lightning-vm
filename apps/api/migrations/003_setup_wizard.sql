-- Wizard progress survives restarts so setup can be resumed. Holds no secrets.
CREATE TABLE setup_progress (
  step text PRIMARY KEY CHECK (step IN ('language', 'checks', 'access', 'domain', 'services', 'vmware', 'discovery', 'pools', 'monitoring')),
  status text NOT NULL CHECK (status IN ('completed', 'skipped')),
  data jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES ('public_url', 'null');
