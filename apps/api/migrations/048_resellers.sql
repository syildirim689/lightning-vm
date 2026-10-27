-- Resellers (reseller.ts): an allocation and a discount for an account that runs servers for its own customers.
-- A customer belongs to at most one reseller (users.reseller_id); their servers are billed to the reseller.
CREATE TABLE resellers (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  max_customers int CHECK (max_customers >= 0),
  max_servers int CHECK (max_servers >= 0),
  max_vcpu int CHECK (max_vcpu >= 0),
  max_memory_mb int CHECK (max_memory_mb >= 0),
  max_disk_gb int CHECK (max_disk_gb >= 0),
  discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 90),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN reseller_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX users_reseller ON users (reseller_id) WHERE reseller_id IS NOT NULL;
