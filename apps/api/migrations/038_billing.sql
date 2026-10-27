-- Billing (billing.ts, rules in billing-rules.ts): a subscription per server or data center, invoices that become a legal
-- invoice (numbered, then sent as e-Fatura/e-Arşiv) only once paid, payments through the payment providers, the
-- customer's balance (a ledger) and saved cards. Off until an admin turns billing on (Settings → Billing).

-- The customer's invoice details: a person (TCKN) or a company (VKN, tax office); a foreign customer has its own tax number.
CREATE TABLE billing_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('individual', 'company')),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  tax_id text NOT NULL CHECK (length(tax_id) BETWEEN 5 AND 20),
  tax_office text,
  country char(2) NOT NULL DEFAULT 'TR',
  city text, district text, address text, postal_code text,
  email text, phone text,
  -- e-Fatura: whether the tax id is a registered e-invoice user and its inbox alias (looked up at the integrator).
  einvoice_registered boolean, einvoice_alias text, einvoice_checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- What is billed every period. A server ordered while billing is on starts 'pending' until its first invoice is paid.
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('server', 'vdc')),
  server_id uuid REFERENCES servers(id) ON DELETE SET NULL,
  vdc_id uuid REFERENCES vdcs(id) ON DELETE SET NULL,
  description text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL,
  period_months smallint NOT NULL DEFAULT 1 CHECK (period_months IN (1, 3, 6, 12)),
  status text NOT NULL CHECK (status IN ('pending', 'active', 'past_due', 'suspended', 'cancelled', 'ended')),
  period_start date, period_end date,
  auto_renew boolean NOT NULL DEFAULT true,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  suspended_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_one_per_server ON subscriptions (server_id) WHERE server_id IS NOT NULL AND status NOT IN ('cancelled', 'ended');
CREATE UNIQUE INDEX subscriptions_one_per_vdc ON subscriptions (vdc_id) WHERE vdc_id IS NOT NULL AND status NOT IN ('cancelled', 'ended');
CREATE INDEX subscriptions_owner ON subscriptions (owner_id);
CREATE INDEX subscriptions_due ON subscriptions (period_end) WHERE status IN ('active', 'past_due', 'suspended');

-- Yearly number series per prefix (GİB format: 3 characters + year + 9 digits, e.g. LVM2026000000001).
CREATE TABLE invoice_sequences (prefix char(3) NOT NULL, year smallint NOT NULL, last integer NOT NULL DEFAULT 0, PRIMARY KEY (prefix, year));

-- An invoice is 'unpaid' (shown as awaiting payment; a pro forma, no legal number) until paid; then it gets its number
-- and goes to the e-invoice integrator. Buyer and seller are copied at the time, so later edits do not change it.
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text UNIQUE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('order', 'renewal', 'topup', 'manual', 'credit_note')),
  status text NOT NULL CHECK (status IN ('unpaid', 'paid', 'cancelled', 'refunded', 'partially_refunded')),
  currency char(3) NOT NULL,
  subtotal numeric(12,2) NOT NULL, tax_total numeric(12,2) NOT NULL, total numeric(12,2) NOT NULL,
  paid_total numeric(12,2) NOT NULL DEFAULT 0, refunded_total numeric(12,2) NOT NULL DEFAULT 0,
  tax_exemption text, -- e.g. '302' (service export) when the rate is 0
  due_at timestamptz NOT NULL, paid_at timestamptz, issued_at timestamptz, cancelled_at timestamptz,
  overdue_notified_at timestamptz, reminded_at timestamptz,
  buyer jsonb NOT NULL, seller jsonb NOT NULL,
  related_invoice_id uuid REFERENCES invoices(id),
  note text,
  -- Automatic collection (balance, then the default saved card): how often tried and when next.
  charge_attempts smallint NOT NULL DEFAULT 0, next_charge_at timestamptz,
  -- e-Fatura / e-Arşiv (einvoice.ts).
  einvoice_status text NOT NULL DEFAULT 'none' CHECK (einvoice_status IN ('none', 'queued', 'sent', 'accepted', 'rejected', 'failed', 'cancelled')),
  einvoice_profile text, einvoice_uuid uuid, einvoice_provider text, einvoice_ref text, einvoice_error text, einvoice_attempts smallint NOT NULL DEFAULT 0, einvoice_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_owner ON invoices (owner_id, created_at DESC);
CREATE INDEX invoices_open ON invoices (due_at) WHERE status = 'unpaid';

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity numeric(12,3) NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'C62', -- UN/ECE: C62 piece, MON month
  unit_price numeric(14,4) NOT NULL,
  tax_rate numeric(5,2) NOT NULL,
  net numeric(12,2) NOT NULL, tax numeric(12,2) NOT NULL, gross numeric(12,2) NOT NULL,
  period_start date, period_end date,
  sort smallint NOT NULL DEFAULT 0
);
CREATE INDEX invoice_lines_invoice ON invoice_lines (invoice_id);
-- One renewal invoice per subscription period.
CREATE UNIQUE INDEX invoice_lines_one_period ON invoice_lines (subscription_id, period_start) WHERE subscription_id IS NOT NULL AND period_start IS NOT NULL;

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider text NOT NULL,  -- a payment_gateways id, 'sandbox', 'balance' or 'manual'
  mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test')),
  method text NOT NULL CHECK (method IN ('card', 'saved_card', 'balance', 'bank_transfer', 'cash', 'other')),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled', 'refunded', 'partially_refunded')),
  amount numeric(12,2) NOT NULL CHECK (amount > 0), currency char(3) NOT NULL, refunded numeric(12,2) NOT NULL DEFAULT 0,
  provider_ref text, error_code text, error_message text, reference text,
  save_card boolean NOT NULL DEFAULT false, automatic boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX payments_invoice ON payments (invoice_id);
CREATE UNIQUE INDEX payments_provider_ref ON payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- The customer's balance per currency: credits (top-ups, refunds to balance, adjustments) and debits (invoices paid).
CREATE TABLE balance_entries (
  id bigserial PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount <> 0),
  currency char(3) NOT NULL,
  reason text NOT NULL CHECK (reason IN ('topup', 'invoice', 'refund', 'adjustment')),
  note text, invoice_id uuid REFERENCES invoices(id), payment_id uuid REFERENCES payments(id),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX balance_entries_owner ON balance_entries (owner_id, currency);

-- Cards stored at the payment provider; only its token (encrypted) and what can be shown are kept here.
CREATE TABLE saved_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL, mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test')),
  token_enc text NOT NULL,
  brand text, last4 char(4), exp_month smallint, exp_year smallint, holder text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX saved_cards_one_default ON saved_cards (owner_id) WHERE is_default;

-- A server held for unpaid invoices: powered off and locked against its owner until paid.
ALTER TABLE servers ADD COLUMN billing_hold boolean NOT NULL DEFAULT false;
