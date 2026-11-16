-- A connection may be a Proxmox VE cluster or node as well as ESXi / vCenter (the tables keep their vmware_
-- names: they hold the inventory of whatever platform the connection is). The adapter is chosen by this kind.
ALTER TABLE vmware_connections DROP CONSTRAINT IF EXISTS vmware_connections_kind_check;
ALTER TABLE vmware_connections ADD CONSTRAINT vmware_connections_kind_check CHECK (kind IN ('esxi', 'vcenter', 'proxmox'));
