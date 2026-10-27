-- Pay as you go: an hourly server has no subscription. Each hour it exists (started hours, on or off: its resources are
-- held) adds its hourly price to the month's usage; at the start of a month the usage becomes one invoice paid from the
-- balance. While the balance minus unbilled usage is negative, the owner's hourly servers are held (billing_hold).
ALTER TABLE servers ADD COLUMN billing_mode text NOT NULL DEFAULT 'monthly' CHECK (billing_mode IN ('monthly', 'hourly')),
  ADD COLUMN price_hourly numeric(12,4) CHECK (price_hourly >= 0),
  ADD COLUMN billed_until timestamptz;
CREATE TABLE server_usage (
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month date NOT NULL, -- first day of the month
  hours int NOT NULL DEFAULT 0,
  amount numeric(14,4) NOT NULL DEFAULT 0,
  currency char(3) NOT NULL,
  invoice_id uuid REFERENCES invoices(id),
  PRIMARY KEY (server_id, month)
);
CREATE INDEX server_usage_open ON server_usage (owner_id) WHERE invoice_id IS NULL;
ALTER TABLE invoices DROP CONSTRAINT invoices_kind_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_kind_check CHECK (kind IN ('order', 'renewal', 'topup', 'manual', 'credit_note', 'usage'));
ALTER TABLE users ADD COLUMN balance_warned_on date; -- the last day a low-balance warning went out
