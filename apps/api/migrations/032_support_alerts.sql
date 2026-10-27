-- Support alerts (support.ts): when a ticket's deadline passed and staff were told; a new deadline re-arms it.
ALTER TABLE tickets ADD COLUMN overdue_alerted_at timestamptz;
