-- Support tickets (support.ts): departments, tickets with a response deadline (SLA), messages (staff notes can be
-- internal), small attachments kept in the database, canned replies for staff, and a rating after closing.
CREATE TABLE support_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_tr text NOT NULL CHECK (length(name_tr) BETWEEN 1 AND 60),
  name_en text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 60),
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);
INSERT INTO support_departments (name_tr, name_en, sort) VALUES
  ('Teknik destek', 'Technical support', 1), ('Faturalama', 'Billing', 2), ('Satış', 'Sales', 3), ('Kötüye kullanım', 'Abuse', 4);

CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY (START WITH 1001) UNIQUE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id uuid REFERENCES support_departments(id) ON DELETE SET NULL,
  server_id uuid REFERENCES servers(id) ON DELETE SET NULL,
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  subject text NOT NULL CHECK (length(subject) BETWEEN 3 AND 160),
  -- open: waits for staff; answered: waits for the customer; customer_reply: the customer answered; on_hold; closed
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'customer_reply', 'on_hold', 'closed')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_at timestamptz,                 -- when staff should answer (SLA); NULL while waiting on the customer
  first_response_at timestamptz,
  last_customer_at timestamptz NOT NULL DEFAULT now(),
  last_staff_at timestamptz,
  closed_at timestamptz,
  rating smallint CHECK (rating BETWEEN 1 AND 5),
  rating_comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_owner ON tickets (owner_id, updated_at DESC);
CREATE INDEX tickets_queue ON tickets (status, due_at);

CREATE TABLE ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  staff boolean NOT NULL,
  internal boolean NOT NULL DEFAULT false,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_messages_ticket ON ticket_messages (ticket_id, created_at);

CREATE TABLE ticket_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES ticket_messages(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL,
  size int NOT NULL,
  data bytea NOT NULL
);
CREATE INDEX ticket_attachments_message ON ticket_attachments (message_id);

CREATE TABLE canned_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The built-in support role answers tickets; administrators have everything already.
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT p FROM unnest(permissions || ARRAY['support.view', 'support.manage']) p ORDER BY p), updated_at = now() WHERE key = 'support';
