-- A connection may also be an oVirt Engine (services/ovirt speaks its REST API behind the same contract).
ALTER TABLE vmware_connections DROP CONSTRAINT IF EXISTS vmware_connections_kind_check;
ALTER TABLE vmware_connections ADD CONSTRAINT vmware_connections_kind_check CHECK (kind IN ('esxi', 'vcenter', 'proxmox', 'xcpng', 'ovirt'));
