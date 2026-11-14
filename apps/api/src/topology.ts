// Topology screens: the live structure of the infrastructure (admin) and of a customer's own servers. Each
// VMware endpoint is read through the adapter at most every 15 seconds (Redis cache, kept 60 seconds and refreshed
// by one caller at a time); everything else comes from the database (servers, pools, locations, firewalls).
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { pool, redis } from './db';
import { SessionGuard, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { callAdapter, storedTarget } from './vmware';

type Vm = { moref: string; name: string; host: string; power: string; cpuUsedMhz: number; memUsedMb: number; rxKBps: number | null; txKBps: number | null };
type Live = { time: string; compute: { moref: string; name: string; kind: string }[];
  hosts: { moref: string; name: string; compute: string; state: string; power: string; cpuUsedMhz: number; cpuTotalMhz: number; memUsedMb: number; memTotalMb: number }[];
  datastores: { moref: string; name: string; capacityGb: number; freeGb: number; hosts: string[] }[]; vms: Vm[]; otherVms: number };

type Reading = Live | { error: string };
const fresh = 15_000; // older than this, the next caller refreshes it (the screens poll every 15 seconds)
const keep = 60; // seconds a reading is served at most, while one caller refreshes it
const adapterTimeout = 60_000;

async function read(c: Record<string, string | number>): Promise<Reading> {
  try {
    return await callAdapter<Live>('/v1/topology', storedTarget(c), adapterTimeout);
  } catch (e) {
    return { error: (e as { getResponse?: () => { code?: string } }).getResponse?.().code ?? 'VMWARE_ERROR' };
  }
}

// Reads the endpoint and stores the result (an error too, so a dead endpoint is not asked on every poll).
async function refresh(c: Record<string, string | number>, key: string, lock: string): Promise<Reading> {
  try {
    const data = await read(c);
    await redis.set(key, JSON.stringify({ at: Date.now(), data }), 'EX', keep).catch(() => undefined);
    return data;
  } finally {
    await redis.del(lock).catch(() => undefined);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Stale-while-refresh: a reading younger than 15 seconds is served as is; an older one is still served while the
// caller that wins the lock (SET NX) refreshes it in the background. With nothing cached, the winner reads VMware
// and the others wait for its result instead of each asking the endpoint themselves.
async function live(c: Record<string, string | number>): Promise<Reading> {
  const key = `topology:v2:${c.id}`;
  const lock = `lock:topology:${c.id}`;
  const cached = async () => {
    const hit = await redis.get(key).catch(() => null);
    return hit ? (JSON.parse(hit) as { at: number; data: Reading }) : null;
  };
  // Redis down: the lock cannot be taken, so read VMware directly as before.
  const claim = () => redis.set(lock, '1', 'PX', adapterTimeout + 5_000, 'NX').then((r) => r === 'OK', () => null);
  const hit = await cached();
  if (hit) {
    if (Date.now() - hit.at >= fresh && (await claim())) refresh(c, key, lock).catch(() => undefined);
    return hit.data;
  }
  const won = await claim();
  if (won !== false) return won ? refresh(c, key, lock) : read(c);
  for (const end = Date.now() + adapterTimeout + 5_000; Date.now() < end;) {
    await sleep(250);
    const later = await cached();
    if (later) return later.data;
    if (!(await redis.exists(lock).catch(() => 0))) break; // the other caller gave up without storing anything
  }
  return (await claim()) ? refresh(c, key, lock) : read(c);
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
    for (const d of await Promise.all(conns.map((c) => live(c)))) if ('vms' in d) for (const v of d.vms) vms.set(v.name, v);
    const used = new Set(servers.map((s) => s.locationId));
    return { time: new Date().toISOString(), locations: locs.filter((l) => used.has(l.id)),
      servers: servers.map((s) => { const { owner: _o, connectionId: _c, computeMoref: _m, vmMoref: _v, ...rest } = withLive(s, vms) as Record<string, unknown>; return rest; }) };
  }
}
