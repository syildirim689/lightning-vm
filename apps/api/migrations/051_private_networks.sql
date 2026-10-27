-- Private networks (privnet.ts): a customer's own network in a location, a distributed port group with its own VLAN
-- from the range the admin gives the location (on the switch of a reference port group). Servers join with a second
-- NIC and get an address of the network's subnet.
ALTER TABLE resource_pools ADD COLUMN private_portgroup_moref text, ADD COLUMN private_vlan_min int CHECK (private_vlan_min BETWEEN 1 AND 4094),
  ADD COLUMN private_vlan_max int CHECK (private_vlan_max BETWEEN 1 AND 4094);
CREATE TABLE private_networks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pool_id uuid NOT NULL REFERENCES resource_pools(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  cidr cidr NOT NULL,
  vlan int NOT NULL,
  portgroup_moref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_id, vlan)
);
CREATE TABLE private_network_members (
  network_id uuid NOT NULL REFERENCES private_networks(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  address inet NOT NULL,
  mac text,
  status text NOT NULL DEFAULT 'joining' CHECK (status IN ('joining', 'joined', 'leaving', 'failed')),
  PRIMARY KEY (network_id, server_id),
  UNIQUE (network_id, address)
);
ALTER TABLE operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE operations ADD CONSTRAINT operations_kind_check
  CHECK (kind IN ('create', 'delete', 'power_on', 'shutdown', 'power_off', 'reset', 'snapshot_create', 'snapshot_revert', 'snapshot_delete', 'resize', 'reinstall',
    'backup_create', 'backup_restore', 'backup_delete', 'migrate', 'disk_add', 'disk_remove', 'nic_add', 'nic_remove'));
