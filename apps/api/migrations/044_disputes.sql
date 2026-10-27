-- Invoice disputes: a customer contests an invoice (or some of its lines) with a reason and an amount. The conversation
-- runs in a Billing support ticket (attachments, internal notes); the dispute keeps the case: its state, a decision date,
-- and the outcome (credit to the balance, refund, or the unpaid invoice withdrawn). While a dispute is open the invoice
-- is not collected (no automatic charge, reminders or suspension).
CREATE TABLE invoice_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY (START WITH 1001) UNIQUE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (reason IN ('wrong_amount', 'not_used', 'duplicate', 'service_problem', 'cancelled', 'tax_details', 'other')),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  line_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'accepted', 'partially_accepted', 'rejected', 'withdrawn')),
  remedy text CHECK (remedy IN ('balance', 'refund', 'cancel')),
  resolved_amount numeric(12,2),
  resolution text,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  due_at timestamptz NOT NULL,
  escalated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invoice_disputes_one_open ON invoice_disputes (invoice_id) WHERE status IN ('open', 'under_review');
CREATE INDEX invoice_disputes_queue ON invoice_disputes (status, due_at);
ALTER TABLE invoices ADD COLUMN disputed boolean NOT NULL DEFAULT false;
