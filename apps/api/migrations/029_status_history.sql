-- Status page history (status.ts): one sample of every component's state each 5 minutes, kept 90 days.
CREATE TABLE status_samples (
  at timestamptz NOT NULL DEFAULT now(),
  services jsonb NOT NULL
);
CREATE INDEX status_samples_at ON status_samples (at);
-- Incidents shown on the status page, with their updates over time.
CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  impact text NOT NULL CHECK (impact IN ('minor', 'major', 'maintenance')),
  status text NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  components text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE TABLE incident_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_updates_incident ON incident_updates (incident_id, created_at);
