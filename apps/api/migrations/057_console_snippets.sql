-- A person's own saved console commands, typed into a server console or the admin terminal with one click.
CREATE TABLE console_snippets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  command text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX console_snippets_owner ON console_snippets (owner_id, name);
