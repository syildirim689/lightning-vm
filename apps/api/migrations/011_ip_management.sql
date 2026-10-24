-- IP management for routed (colocation) blocks: several addresses per server (primary IPv4, extra IPv4
-- bought with the order, one IPv6), reverse DNS per address, and a quarantine before a released address is
-- handed to someone else (its reputation may still be the previous customer's).
ALTER TABLE ip_allocations DROP CONSTRAINT ip_allocations_server_id_key;
ALTER TABLE ip_allocations
  ADD COLUMN kind text NOT NULL DEFAULT 'primary' CHECK (kind IN ('primary', 'extra', 'ipv6')),
  ADD COLUMN ptr text;
CREATE UNIQUE INDEX ip_allocations_one_primary ON ip_allocations (server_id) WHERE kind = 'primary';
CREATE UNIQUE INDEX ip_allocations_one_ipv6 ON ip_allocations (server_id) WHERE kind = 'ipv6';

ALTER TABLE ip_pools
  ADD COLUMN quarantine_hours integer NOT NULL DEFAULT 24 CHECK (quarantine_hours BETWEEN 0 AND 8760),
  -- Optional IPv6 on the same network: each server gets one address from this prefix.
  ADD COLUMN ipv6_prefix cidr CHECK (ipv6_prefix IS NULL OR family(ipv6_prefix) = 6),
  ADD COLUMN ipv6_gateway inet CHECK (ipv6_gateway IS NULL OR family(ipv6_gateway) = 6),
  ADD CONSTRAINT ip_pools_ipv6_pair CHECK ((ipv6_prefix IS NULL) = (ipv6_gateway IS NULL));

CREATE TABLE ip_quarantine (
  address inet PRIMARY KEY,
  ip_pool_id uuid NOT NULL REFERENCES ip_pools(id) ON DELETE CASCADE,
  released_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL,
  server_name text
);

-- Extra IPv4 addresses a location sells with a server (0 = not offered).
ALTER TABLE resource_pools
  ADD COLUMN extra_ipv4_max integer NOT NULL DEFAULT 0 CHECK (extra_ipv4_max BETWEEN 0 AND 32),
  ADD COLUMN extra_ipv4_price numeric(10, 2) NOT NULL DEFAULT 0 CHECK (extra_ipv4_price >= 0);
ALTER TABLE servers ADD COLUMN extra_ipv4 integer NOT NULL DEFAULT 0;
ALTER TABLE ip_pools ADD CONSTRAINT ip_pools_ipv6_gateway_inside CHECK (ipv6_gateway IS NULL OR ipv6_gateway << ipv6_prefix);
