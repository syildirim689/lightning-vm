-- Findings a person hid from their own list: for a while (until) or for good (until NULL). Keys are the insight's key.
CREATE TABLE insight_dismissals (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  until timestamptz,
  PRIMARY KEY (user_id, key)
);
