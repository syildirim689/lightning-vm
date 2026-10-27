-- Notes staff keep on a person (admin.ts): who wrote what and when; a pinned one shows in the users list. The person never sees them.
CREATE TABLE staff_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_notes_user ON staff_notes (user_id, created_at DESC);
