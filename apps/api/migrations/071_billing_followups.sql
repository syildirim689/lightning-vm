-- Follow-ups to the billing fixes of 070.
-- dunning_from: the day collection of an invoice began when that is later than its due date. First (order) invoices of
-- servers built before payment and the invoices of a resize or an extra disk were not collected before; one that is already
-- past due now starts at the first step, counted from this migration, instead of going straight to suspension.
ALTER TABLE invoices ADD COLUMN dunning_from timestamptz;
UPDATE invoices SET dunning_from = now() WHERE status = 'unpaid' AND kind IN ('order', 'manual') AND due_at < now();
-- billing_remove: billing decided this server goes ('cancel' at the period's end, 'terminate' unpaid); kept until the
-- delete has really started, so a run that found the server busy tries again instead of leaving it running unbilled.
-- hold_power_off: a hold whose power-off could not start (another operation was open); the next run tries again.
ALTER TABLE servers ADD COLUMN billing_remove text CHECK (billing_remove IN ('cancel', 'terminate')), ADD COLUMN hold_power_off boolean NOT NULL DEFAULT false;
-- staff_cancelled: staff ended this subscription on purpose ("Cancel now"): its server or data center is not given a new
-- one by the next run. Resuming the subscription clears it.
ALTER TABLE subscriptions ADD COLUMN staff_cancelled boolean NOT NULL DEFAULT false;
-- Data centers: an unpaid one was marked suspended but nothing was held. Now that suspension holds and powers off its
-- servers (and termination deletes them), those already suspended start over as overdue, counted from this migration:
-- the suspension comes after the usual days, with its notice, not on the first run after the upgrade.
UPDATE invoices i SET dunning_from = now() FROM invoice_lines l JOIN subscriptions b ON b.id = l.subscription_id
  WHERE l.invoice_id = i.id AND i.status = 'unpaid' AND b.kind = 'vdc' AND b.status IN ('past_due', 'suspended');
UPDATE subscriptions SET status = 'past_due', suspended_at = NULL WHERE kind = 'vdc' AND status = 'suspended';
