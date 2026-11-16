-- A cancelled invoice no longer keeps its subscription period taken. The "one invoice per subscription period" index
-- (038) also counted the lines of cancelled invoices, so after a renewal invoice was cancelled (by staff, or as a dispute's
-- remedy) the next one for the same period hit the index and that subscription was never invoiced again. The lines stay
-- as they were (subscription and period readable in the invoice's history); `withdrawn` takes them out of the index, and
-- billing.ts sets it wherever an invoice is cancelled.
ALTER TABLE invoice_lines ADD COLUMN withdrawn boolean NOT NULL DEFAULT false;
UPDATE invoice_lines l SET withdrawn = true FROM invoices i WHERE i.id = l.invoice_id AND i.status = 'cancelled';
DROP INDEX invoice_lines_one_period;
CREATE UNIQUE INDEX invoice_lines_one_period ON invoice_lines (subscription_id, period_start)
  WHERE subscription_id IS NOT NULL AND period_start IS NOT NULL AND NOT withdrawn;
