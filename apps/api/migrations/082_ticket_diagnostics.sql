-- What the panel knew about a ticket's server at the moment the ticket was opened (support.ts, captured from the
-- database only): its state, shape, addresses, last operations and the owner's unpaid invoices. Staff see it next to
-- the ticket; the customer never does. NULL: no server was named, or the snapshot could not be taken.
ALTER TABLE tickets ADD COLUMN diagnostics jsonb;
