-- Whose share of the worker's slots an operation counts against (worker: operations.mjs, admit): the account that
-- started it (the owner, a reseller acting for a customer) or, for a schedule, the server's owner. NULL: not capped
-- (staff, the billing run, the billing integration, and operations from before this column).
ALTER TABLE operations ADD COLUMN capped_for uuid;
CREATE INDEX operations_capped_open_idx ON operations (capped_for) WHERE status IN ('pending', 'running') AND capped_for IS NOT NULL;

-- When a reseller's customer was told who manages their account (reseller.ts, managedBy): once, the first time they use
-- the panel. Customers from before this column are told at their next visit.
ALTER TABLE users ADD COLUMN reseller_notice_at timestamptz;
