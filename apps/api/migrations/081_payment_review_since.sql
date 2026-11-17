-- When an open payment began to wait for staff (billing.ts, noteReview): shown in Admin → Billing → Payments and
-- behind the "payments in review" finding. Payments already waiting count from when they were begun.
ALTER TABLE payments ADD COLUMN review_since timestamptz;
UPDATE payments SET review_since = created_at WHERE status = 'pending' AND error_code IN ('NEEDS_CONFIRMATION', 'AMOUNT_MISMATCH', 'FRAUD_REVIEW');
