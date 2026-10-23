-- ESXi / vCenter connections and the inventory last discovered through them.
-- The password is AES-256-GCM encrypted with a key kept outside the database (see src/secrets.ts).
CREATE TABLE vmware_connections (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('esxi', 'vcenter')),
  host text NOT NULL,
  port int NOT NULL DEFAULT 443 CHECK (port BETWEEN 1 AND 65535),
  username text NOT NULL,
  password_enc text NOT NULL,
  tls_mode text NOT NULL CHECK (tls_mode IN ('system', 'ca', 'pinned')),
  tls_ca_pem text,
  tls_sha256 text CHECK (tls_sha256 ~ '^[0-9a-f]{64}$'),
  instance_uuid text,
  product jsonb NOT NULL,
  licenses jsonb NOT NULL DEFAULT '[]',
  write_api text NOT NULL CHECK (write_api IN ('available', 'restricted', 'unknown')),
  privileges jsonb NOT NULL DEFAULT '{}',
  operations jsonb NOT NULL DEFAULT '{}',
  warnings jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  last_error_code text,
  last_discovered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host, port)
);
-- The same vCenter reached under two names must not be added twice.
CREATE UNIQUE INDEX vmware_connections_vcenter_instance_key ON vmware_connections (instance_uuid) WHERE kind = 'vcenter';

CREATE TABLE vmware_hosts (
  connection_id uuid NOT NULL REFERENCES vmware_connections(id) ON DELETE CASCADE,
  moref text NOT NULL,
  name text NOT NULL,
  hardware_uuid text NOT NULL,
  vendor text, model text,
  cpu_mhz int, cpu_cores int, cpu_threads int, memory_bytes bigint,
  connection_state text, power_state text, in_maintenance boolean, version text,
  management_server text, parent text,
  PRIMARY KEY (connection_id, moref)
);
-- A physical host is counted once, whether it was found through vCenter or added standalone.
CREATE UNIQUE INDEX vmware_hosts_hardware_uuid_key ON vmware_hosts (hardware_uuid);

CREATE TABLE vmware_datastores (
  connection_id uuid NOT NULL REFERENCES vmware_connections(id) ON DELETE CASCADE,
  moref text NOT NULL,
  name text NOT NULL, type text,
  capacity_bytes bigint NOT NULL, free_bytes bigint NOT NULL, uncommitted_bytes bigint NOT NULL DEFAULT 0,
  accessible boolean NOT NULL, maintenance_mode text, host_morefs text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (connection_id, moref)
);

CREATE TABLE vmware_networks (
  connection_id uuid NOT NULL REFERENCES vmware_connections(id) ON DELETE CASCADE,
  moref text NOT NULL,
  name text NOT NULL, kind text NOT NULL CHECK (kind IN ('standard', 'distributed')),
  vlan int, switch text,
  PRIMARY KEY (connection_id, moref)
);

CREATE TABLE vmware_compute (
  connection_id uuid NOT NULL REFERENCES vmware_connections(id) ON DELETE CASCADE,
  moref text NOT NULL,
  name text NOT NULL, kind text NOT NULL CHECK (kind IN ('cluster', 'standalone')),
  hosts int, effective_cpu_mhz int, effective_memory_mb bigint, resource_pool text,
  PRIMARY KEY (connection_id, moref)
);

CREATE TABLE vmware_vms (
  connection_id uuid NOT NULL REFERENCES vmware_connections(id) ON DELETE CASCADE,
  moref text NOT NULL,
  name text NOT NULL, uuid text, instance_uuid text, power_state text, host_moref text,
  cpu int, memory_mb int, template boolean NOT NULL DEFAULT false, guest text,
  committed_bytes bigint, uncommitted_bytes bigint,
  PRIMARY KEY (connection_id, moref)
);
