-- Reconciliation also reports a server whose VM is listed under another id than the one recorded (Proxmox hands a
-- freed VM number out again; a VM restored or re-created under its name gets a new one). The row takes the new id.
ALTER TABLE reconciliation_findings DROP CONSTRAINT reconciliation_findings_kind_check;
ALTER TABLE reconciliation_findings ADD CONSTRAINT reconciliation_findings_kind_check CHECK (kind IN ('vm_missing', 'orphan_vm', 'power_drift', 'vm_id_changed'));
