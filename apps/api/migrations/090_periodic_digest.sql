-- The periodic digest (apps/api/src/periodic-digest.ts): a person's own choice to get one, when (weekly on a weekday
-- or daily, at an hour of their own time zone), when the next one is due, and which findings were open at the last
-- one, so the next can say what opened and closed since. No row: no digest (off unless turned on).
-- A new, empty table and one partial index: nothing existing is read, rewritten or locked for longer than the DDL.
CREATE TABLE digest_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  frequency text NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('daily', 'weekly')),
  day smallint NOT NULL DEFAULT 1 CHECK (day BETWEEN 1 AND 7),       -- ISO weekday, 1 = Monday (weekly only)
  hour smallint NOT NULL DEFAULT 8 CHECK (hour BETWEEN 0 AND 23),    -- of the person's own clock
  timezone text NOT NULL DEFAULT 'UTC',
  next_at timestamptz,          -- when the next digest is due; moved forward by the run that takes it
  last_run_at timestamptz,      -- the last period worked out, sent or empty
  last_sent_at timestamptz,     -- the last digest that had something to say
  seen jsonb NOT NULL DEFAULT '[]',   -- the findings open at the last run: [{key, code, params}]
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- The run asks for "enabled and due" every five minutes.
CREATE INDEX digest_preferences_due ON digest_preferences (next_at) WHERE enabled;
