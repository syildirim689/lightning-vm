-- held_at: when an hourly server was put on hold for an empty balance. Held longer than the days a suspended
-- subscription is kept, with a usage invoice still unpaid, it is terminated (billing.ts). Servers already on hold start
-- counting now, not from whenever they were held.
ALTER TABLE servers ADD COLUMN held_at timestamptz;
UPDATE servers SET held_at = now() WHERE billing_hold AND billing_mode = 'hourly' AND state <> 'deleted';

-- CPU that was never measured: the XCP-ng, oVirt, libvirt and Incus adapters cannot report a server's or a host's CPU use
-- and answered 0, which was stored as if measured and made every running server there look idle (advice to shrink it, a
-- lower health score). The worker no longer stores those; what is already stored goes, so the advice goes at once.
DELETE FROM server_cpu_samples x USING servers s, resource_pools p, vmware_connections c
  WHERE x.server_id = s.id AND p.id = s.pool_id AND c.id = p.connection_id AND c.kind IN ('xcpng', 'ovirt', 'libvirt', 'incus');
UPDATE power_samples ps SET cpu_util = NULL FROM vmware_connections c
  WHERE c.id = ps.connection_id AND c.kind IN ('xcpng', 'ovirt', 'libvirt', 'incus') AND ps.cpu_util IS NOT NULL;
