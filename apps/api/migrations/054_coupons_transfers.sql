-- Coupons (coupons.ts): a code the customer enters when ordering. Percent or a fixed amount off the monthly price, for the
-- first N invoices (periods; NULL: every invoice), limited in uses, time and packages. A use is a row in coupon_redemptions,
-- so an order that is never paid gives its use back when it is withdrawn.
CREATE TABLE coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{3,32}$'),
  kind text NOT NULL CHECK (kind IN ('percent', 'fixed')),
  value numeric(12,2) NOT NULL CHECK (value > 0 AND (kind <> 'percent' OR value <= 100)),
  currency char(3), -- a fixed amount's currency
  periods int CHECK (periods BETWEEN 1 AND 120),
  max_uses int CHECK (max_uses > 0),
  once_per_user boolean NOT NULL DEFAULT true,
  new_customers boolean NOT NULL DEFAULT false, -- only for accounts with no server yet
  package_ids uuid[], -- NULL: every package and custom shapes
  expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'fixed' OR currency IS NOT NULL)
);
CREATE TABLE coupon_redemptions (
  coupon_id uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id uuid REFERENCES servers(id) ON DELETE SET NULL,
  once boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX coupon_redemptions_once ON coupon_redemptions (coupon_id, user_id) WHERE once;
CREATE INDEX coupon_redemptions_server ON coupon_redemptions (server_id);
-- The subscription remembers its coupon and how many more renewals it discounts (NULL with a coupon: all of them).
ALTER TABLE subscriptions ADD COLUMN coupon_id uuid REFERENCES coupons(id) ON DELETE SET NULL, ADD COLUMN coupon_left int;

-- Handing a server to another account (transfers.ts): the owner offers it, the other account accepts within a week.
CREATE TABLE server_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  from_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  decided_at timestamptz
);
CREATE UNIQUE INDEX server_transfers_open ON server_transfers (server_id) WHERE status = 'pending';
CREATE INDEX server_transfers_to ON server_transfers (to_id, status);
