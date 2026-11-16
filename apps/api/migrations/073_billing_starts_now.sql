-- No back-billing at the upgrade. Subscriptions that were not invoiced because of the errors fixed in 070-072 (stuck
-- behind a cancelled renewal invoice; automatic renewal off, which used to mean "never invoiced again") have a period
-- that ended in the past. The run would invoice them for that old period and then one period per paid invoice until
-- they caught up; and 070, which gives the periods of cancelled invoices back, would let a renewal that staff cancelled
-- on purpose before the upgrade be issued again. Customers do not get invoices for time that passed because of our
-- errors: billing starts from now.
--
-- Every subscription still in service whose period has ended and that has no unpaid renewal invoice is moved forward
-- by whole periods until its period ends today or later, as the renewal itself moves it (the new period starts where
-- the old one ended, period_months later, the day kept or the month's last day: billing-rules.ts skipPeriods; a
-- PostgreSQL date plus a months interval clamps to the month's end the same way). Nothing is charged for the periods
-- skipped. The next run then makes the invoice for the coming period with the usual lead time, and since no line of a
-- cancelled invoice starts at the new period_end, nothing old is issued again.
--   Left alone: a subscription with an unpaid renewal invoice (it is in dunning, as before); one cancelled at its
--   period's end (it ends, as before); pending, cancelled and ended ones.
-- Days are Istanbul calendar days, as in billing.ts. One audit row per subscription says what was moved
-- (billing.period_moved: from, to, the periods skipped and what one of them would have cost).
-- Nothing matches on a new database or on a second run.
DO $$
DECLARE
  b record;
  s date;
  e date;
  n int;
  moved int := 0;
  today date := (now() AT TIME ZONE 'Europe/Istanbul')::date;
BEGIN
  FOR b IN
    SELECT x.id, x.owner_id, x.kind, x.description, x.amount, x.currency, x.period_start, x.period_end, x.period_months, x.auto_renew
    FROM subscriptions x
    WHERE x.status IN ('active', 'past_due', 'suspended') AND NOT x.cancel_at_period_end
      AND x.period_end IS NOT NULL AND x.period_end < today
      AND NOT EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
                      WHERE l.subscription_id = x.id AND i.kind = 'renewal' AND i.status = 'unpaid')
  LOOP
    s := b.period_start; e := b.period_end; n := 0;
    WHILE e < today LOOP
      s := e;
      e := (e + make_interval(months => b.period_months))::date;
      n := n + 1;
    END LOOP;
    UPDATE subscriptions SET period_start = s, period_end = e, updated_at = now() WHERE id = b.id;
    INSERT INTO audit_events (actor_id, action, outcome, resource_id, metadata)
    VALUES (NULL, 'billing.period_moved', 'success', b.id::text, jsonb_build_object(
      'subscriptionId', b.id, 'target', b.owner_id, 'kind', b.kind, 'description', b.description,
      'fromStart', b.period_start, 'fromEnd', b.period_end, 'toStart', s, 'toEnd', e,
      'periodsSkipped', n, 'amountPerPeriod', (b.amount * b.period_months)::text, 'currency', trim(b.currency),
      'autoRenew', b.auto_renew, 'reason', 'migration 073: billing starts from the upgrade, past periods are not invoiced'));
    moved := moved + 1;
  END LOOP;
  RAISE NOTICE '073: % subscription(s) moved to the current period; see audit_events where action = ''billing.period_moved''', moved;
END $$;
