-- "While you were away" (apps/api/src/away.ts): the moment a person last marked that list as seen, by a click.
-- Notifications after it (finished and failed operations, invoices, ticket answers) make the list. A nullable
-- column without a default: no row is rewritten, and nothing is locked for longer than the DDL.
ALTER TABLE users ADD COLUMN away_seen_at timestamptz;
