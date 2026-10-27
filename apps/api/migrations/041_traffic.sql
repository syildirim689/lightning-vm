-- Network traffic per server and day (bytes in and out, from VMware's realtime counters, worker power.mjs), and a
-- monthly allowance: a package's, else the location's for custom shapes; NULL means unlimited. The server keeps the
-- allowance it was ordered (or resized) with. Warnings at 80 % and 100 % go out once per calendar month.
CREATE TABLE server_traffic (
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  day date NOT NULL,
  rx_bytes bigint NOT NULL DEFAULT 0,
  tx_bytes bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, day)
);
ALTER TABLE servers ADD COLUMN traffic_gb int CHECK (traffic_gb IS NULL OR traffic_gb > 0),
  ADD COLUMN traffic_counted_at timestamptz,
  ADD COLUMN traffic_warned text; -- "2026-10:80" or "2026-10:100": the last warning sent this month
ALTER TABLE packages ADD COLUMN traffic_gb int CHECK (traffic_gb IS NULL OR traffic_gb > 0);
ALTER TABLE resource_pools ADD COLUMN traffic_gb int CHECK (traffic_gb IS NULL OR traffic_gb > 0);
