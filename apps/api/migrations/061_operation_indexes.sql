-- Indexes for the hot operation reads, which otherwise scan the whole table as it grows:
-- the admin list (newest 200), the per-hour limit in startOperation (one owner's last hour) and the task
-- manager (open ones, read through operations_open_idx, plus those finished in the last 15 minutes).
CREATE INDEX IF NOT EXISTS operations_created_idx ON operations (created_at DESC);
CREATE INDEX IF NOT EXISTS operations_owner_created_idx ON operations (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS operations_finished_idx ON operations (finished_at) WHERE finished_at IS NOT NULL;
