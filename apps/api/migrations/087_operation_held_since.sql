-- Since when an operation that has not begun waits for its account's share of the worker's slots (operations.capped_for,
-- migration 084; worker: operations.mjs, admit). Set the first time it is held; when it starts, its deadline moves on by
-- the time since then (within OPERATIONS_HELD_HOURS) and this is cleared: the wait does not count against the deadline.
ALTER TABLE operations ADD COLUMN held_since timestamptz;
