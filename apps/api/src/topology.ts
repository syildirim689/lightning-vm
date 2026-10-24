// Topology screens: the live structure of the infrastructure (admin) and of a customer's own servers. Each
// VMware endpoint is read through the adapter at most every 15 seconds (Redis cache); everything else comes
// from the database (servers, pools, locations, firewalls).
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { pool, redis } from './db';
import { SessionGuard, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { callAdapter, storedTarget } from './vmware';

type Vm = { moref: string; name: string; host: string; power: string; cpuUsedMhz: number; memUsedMb: number; rxKBps: number | null; txKBps: number | null };
type Live = { time: string; compute: { moref: string; name: string; kind: string }[];
  hosts: { moref: string; name: string; compute: string; state: string; power: string; cpuUsedMhz: number; cpuTotalMhz: number; memUsedMb: number; memTotalMb: number }[];
  datastores: { moref: string; name: string; capacityGb: number; freeGb: number; hosts: string[] }[]; vms: Vm[]; otherVms: number };

async function live(c: Record<string, string | number>): Promise<Live | { error: string }> {
  const key = `topology:${c.id}`;
  const hit = await redis.get(key).catch(() => null);
  if (hit) return JSON.parse(hit);
  try {
    const out = await callAdapter<Live>('/v1/topology', storedTarget(c), 60_000);
    await redis.set(key, JSON.stringify(out), 'EX', 15).catch(() => undefined);
    return out;
  } catch (e) {
    const error = (e as { getResponse?: () => { code?: string } }).getResponse?.().code ?? 'VMWARE_ERROR';
    await redis.set(key, JSON.stringify({ error }), 'EX', 15).catch(() => undefined);
    return { error };
  }
}

const serverRows = (where: string, params: unknown[]) => pool.query(`SELECT s.id, s.name, s.state, s.vm_moref AS "vmMoref", s.vcpu, s.memory_mb AS "memoryMb",
    p.connection_id AS "connectionId", p.compute_moref AS "computeMoref", p.location_id AS "locationId", host(a.address) AS address, u.email AS owner,
    ARRAY(SELECT f.name FROM firewall_servers fs JOIN firewalls f ON f.id = fs.firewall_id WHERE fs.server_id = s.id ORDER BY f.name) AS firewalls
  FROM servers s JOIN resource_pools p ON p.id = s.pool_id JOIN users u ON u.id = s.owner_id
  LEFT JOIN ip_allocations a ON a.server_id = s.id AND a.kind = 'primary' WHERE s.state <> 'deleted' AND ${where} ORDER BY s.name`, params);

const locations = () => pool.query(`SELECT id, name, city, country_code AS "countryCode", datacenter, latitude::float8 AS latitude, longitude::float8 AS longitude, status
  FROM locations ORDER BY sort, name`);

// A VM's live numbers joined to its server row (the VM name is lvm-<server id>).
function withLive(s: Record<string, unknown>, vms: Map<string, Vm>) {
  const v = vms.get(`lvm-${s.id}`);
  return { ...s, power: v?.power ?? null, host: v?.host ?? null, cpuUsedMhz: v?.cpuUsedMhz ?? null, memUsedMb: v?.memUsedMb ?? null, rxKBps: v?.rxKBps ?? null, txKBps: v?.txKBps ?? null };
}

@Controller('admin') @UseGuards(PermissionGuard)
export class TopologyAdminController {
  @Get('topology') @Can('dashboard.view', 'servers.view_all')
  async topology() {
    const [{ rows: conns }, { rows: pools }, { rows: servers }, { rows: locs }] = await Promise.all([
      pool.query('SELECT * FROM vmware_connections ORDER BY name'),
      pool.query('SELECT id, name, connection_id AS "connectionId", compute_moref AS "computeMoref", location_id AS "locationId", active FROM resource_pools ORDER BY name'),
      serverRows('true', []), locations(),
    ]);
    const connections = await Promise.all(conns.map(async (c) => {
      const data = await live(c);
      const vms = new Map(('vms' in data ? data.vms : []).map((v) => [v.name, v]));
      return { id: c.id, name: c.name, kind: c.kind, host: c.host, ...data,
        servers: servers.filter((s) => s.connectionId === c.id).map((s) => withLive(s, vms)) };
    }));
    return { time: new Date().toISOString(), locations: locs, pools, connections };
  }
}

@Controller() @UseGuards(SessionGuard)
export class TopologyController {
  // The customer's own servers with their location, firewalls and live traffic; no infrastructure details.
  @Get('topology')
  async mine(@Req() req: AuthedRequest) {
    const [{ rows: servers }, { rows: locs }] = await Promise.all([serverRows('s.owner_id = $1', [req.user.id]), locations()]);
    const ids = [...new Set(servers.map((s) => s.connectionId as string))];
    const { rows: conns } = ids.length ? await pool.query('SELECT * FROM vmware_connections WHERE id = ANY($1::uuid[])', [ids]) : { rows: [] };
    const vms = new Map<string, Vm>();
    for (const c of conns) { const d = await live(c); if ('vms' in d) for (const v of d.vms) vms.set(v.name, v); }
    const used = new Set(servers.map((s) => s.locationId));
    return { time: new Date().toISOString(), locations: locs.filter((l) => used.has(l.id)),
      servers: servers.map((s) => { const { owner: _o, connectionId: _c, computeMoref: _m, vmMoref: _v, ...rest } = withLive(s, vms) as Record<string, unknown>; return rest; }) };
  }
}
