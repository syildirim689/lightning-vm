// Staff move servers between hosts and datastores of their vCenter (vMotion, Storage vMotion) without stopping them:
// one server to a chosen place, or every panel server off a host before its maintenance (each to the host of the same
// cluster that has the fewest of them). Hosts and placement come from the last inventory discovery.
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { audit, type AuthedRequest } from './auth';
import { capabilitiesOf } from './capacity';
import { platformCan } from './catalog';
import { pool } from './db';
import { apiError } from './errors';
import { Can, PermissionGuard } from './rbac';
import { findServer, hashOf, startOperation } from './servers';

// The hosts a server of this pool can run on, with how many panel servers each runs now.
async function hostsOf(poolId: string) {
  const { rows } = await pool.query(`SELECT h.moref, h.name, h.in_maintenance AS "inMaintenance", h.connection_state AS state,
      (SELECT count(*)::int FROM vmware_vms v JOIN servers s ON s.vm_moref = v.moref AND s.state <> 'deleted' WHERE v.connection_id = h.connection_id AND v.host_moref = h.moref) AS servers
    FROM vmware_hosts h JOIN resource_pools p ON p.connection_id = h.connection_id WHERE p.id = $1 AND (h.parent = p.compute_moref OR h.moref = p.compute_moref) ORDER BY h.name`, [poolId]);
  return rows as { moref: string; name: string; inMaintenance: boolean | null; state: string | null; servers: number }[];
}
const usable = (h: { inMaintenance: boolean | null; state: string | null }) => !h.inMaintenance && h.state === 'connected';

function move(req: AuthedRequest, server: { id: string; owner_id: string }, host: string | null, datastore: string | null) {
  const key = `migrate:${server.id}:${randomUUID()}`;
  return startOperation(req, server, 'migrate', key, hashOf({ id: server.id, host, datastore, key }), { host, datastore });
}

@Controller('admin') @UseGuards(PermissionGuard)
export class PlacementController {
  // Where the server is now and where it could go.
  @Get('servers/:id/placement') @Can('servers.manage_all')
  async placement(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id, true);
    const { rows: [vm] } = await pool.query(`SELECT v.host_moref AS host FROM vmware_vms v JOIN resource_pools p ON p.connection_id = v.connection_id WHERE p.id = $1 AND v.moref = $2`, [s.pool_id, s.vm_moref]);
    const { rows: datastores } = await pool.query(`SELECT d.moref, d.name, d.free_bytes::float8 AS "freeBytes", d.accessible FROM vmware_datastores d JOIN resource_pools p ON p.connection_id = d.connection_id
      WHERE p.id = $1 ORDER BY d.name`, [s.pool_id]);
    return { host: vm?.host ?? null, hosts: await hostsOf(s.pool_id), datastores };
  }

  @Post('servers/:id/migrate') @HttpCode(202) @Can('servers.manage_all')
  async migrate(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const s = await findServer(req, id, true);
    if (s.state !== 'ready' || !s.vm_moref) throw apiError(409, 'INVALID_SERVER_STATE', 'Not possible in this state');
    await platformCan(s.pool_id, 'migrate');
    const host = typeof body?.hostMoref === 'string' && body.hostMoref ? body.hostMoref : null;
    const datastore = typeof body?.datastoreMoref === 'string' && body.datastoreMoref ? body.datastoreMoref : null;
    const fields: Record<string, string> = {};
    if (!host && !datastore) fields.hostMoref = 'REQUIRED';
    if (host && !(await hostsOf(s.pool_id)).some((h) => h.moref === host && usable(h))) fields.hostMoref = 'NOT_AVAILABLE';
    if (datastore && !(await pool.query('SELECT 1 FROM vmware_datastores d JOIN resource_pools p ON p.connection_id = d.connection_id WHERE p.id = $1 AND d.moref = $2 AND d.accessible', [s.pool_id, datastore])).rowCount) {
      fields.datastoreMoref = 'NOT_AVAILABLE';
    }
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    const operation = await move(req, s, host, datastore);
    await audit(req, 'server.migrate', 'success', req.user.id, { serverId: id, host, datastore });
    return { operation };
  }

  // Every panel server on a host goes to the other hosts of its cluster, the least loaded first. Servers busy with
  // another operation are left (listed) for a second try.
  @Post('vmware/connections/:id/hosts/:host/evacuate') @HttpCode(202) @Can('servers.manage_all')
  async evacuate(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) connectionId: string, @Param('host') hostMoref: string) {
    const { rows: [c] } = await pool.query('SELECT kind, operations FROM vmware_connections WHERE id = $1', [connectionId]);
    if (c && !capabilitiesOf(c.kind, c.operations).migrate) throw apiError(409, 'PLATFORM_NOT_SUPPORTED', 'This platform cannot move servers yet');
    const { rows: servers } = await pool.query(`SELECT s.id, s.owner_id, s.name, s.pool_id FROM servers s JOIN resource_pools p ON p.id = s.pool_id
      JOIN vmware_vms v ON v.connection_id = p.connection_id AND v.moref = s.vm_moref WHERE p.connection_id = $1 AND v.host_moref = $2 AND s.state = 'ready' ORDER BY s.name`, [connectionId, hostMoref]);
    const planned = new Map<string, number>();
    const started: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const s of servers) {
      const load = (h: { moref: string; servers: number }) => h.servers + (planned.get(h.moref) ?? 0);
      const targets = (await hostsOf(s.pool_id)).filter((h) => h.moref !== hostMoref && usable(h)).sort((a, b) => load(a) - load(b));
      if (!targets.length) { skipped.push({ name: s.name, reason: 'NO_OTHER_HOST' }); continue; }
      try {
        await move(req, s, targets[0].moref, null);
        planned.set(targets[0].moref, (planned.get(targets[0].moref) ?? 0) + 1);
        started.push(s.name);
      } catch (e) { skipped.push({ name: s.name, reason: (e as { getResponse?: () => { code?: string } }).getResponse?.().code ?? 'FAILED' }); }
    }
    await audit(req, 'vmware.host_evacuate', 'success', req.user.id, { connectionId, host: hostMoref, started: started.length, skipped: skipped.length });
    return { started, skipped };
  }
}
