-- A customer's monthly budget (budget.ts): the amount, its currency, and the month an "over budget" notice went out.
ALTER TABLE users ADD COLUMN budget_monthly numeric(12, 2) CHECK (budget_monthly > 0);
ALTER TABLE users ADD COLUMN budget_currency char(3);
ALTER TABLE users ADD COLUMN budget_alerted text;
-- Servers a person starred: first in their lists and in the command palette (staff may star anyone's they can see).
CREATE TABLE server_favorites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, server_id)
);
