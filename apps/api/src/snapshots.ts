// Snapshots of a server: the list comes from VMware; taking, reverting to and removing one are operations (one at a
// time per server, retried, shown in the task list). Snapshots are taken without memory, so a revert leaves the VM
// off; it is powered on again when it was running before.
import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthedRequest } from './auth';
import { pool, redis } from './db';
import { apiError } from './errors';
import { customerMay, findServer, hashOf, idempotencyKey, replay, startOperation, type Kind } from './servers';
import { limitsOf } from './permissions';
import { callAdapter, storedTarget } from './vmware';

// shortcut: a fixed limit per server; make it a setting when operators ask for more.
export const MAX_SNAPSHOTS = 5;
// The role may allow fewer or more (Roles → limits).
const maxFor = (req: AuthedRequest) => limitsOf(req.user.roles.join(',')).maxSnapshots ?? MAX_SNAPSHOTS;
type Snapshot = { id: string; name: string; description: string; created: string; powerState: string; current: boolean; parent: string };

export async function target(serverPoolId: string) {
  const { rows: [c] } = await pool.query('SELECT c.* FROM vmware_connections c JOIN resource_pools p ON p.connection_id = c.id WHERE p.id = $1', [serverPoolId]);
  return storedTarget(c);
}
const ready = (s: { state: string; vm_moref: string | null }) => {
  if (!['ready', 'error'].includes(s.state) || !s.vm_moref) throw apiError(409, 'INVALID_SERVER_STATE', 'Not possible in this state');
};

@Controller('servers/:id/snapshots') @UseGuards(SessionGuard)
export class SnapshotsController {
  @Get()
  async list(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id);
    if (!s.vm_moref || s.state === 'provisioning') return { snapshots: [], max: maxFor(req) };
    // Cached 30 seconds per server. The key carries the server's latest operation and its status, so taking, reverting
    // or removing a snapshot (from here, a schedule or a retry) changes it when the operation starts and again when the
    // worker finishes it: the list never waits out the cache after a change made through the panel.
    const { rows: [op] } = await pool.query('SELECT id, status FROM operations WHERE server_id = $1 ORDER BY created_at DESC LIMIT 1', [id]);
    const key = `snapshots:${id}:${s.vm_moref}:${op ? `${op.id}:${op.status}` : '-'}`;
    const cached = await redis.get(key).catch(() => null);
    if (cached) return { snapshots: JSON.parse(cached) as Snapshot[], max: maxFor(req) };
    const out = await callAdapter<{ snapshots: Snapshot[] }>('/v1/vm/snapshots', { ...(await target(s.pool_id)), vm: s.vm_moref }, 30_000);
    await redis.set(key, JSON.stringify(out.snapshots), 'EX', 30).catch(() => undefined);
    return { snapshots: out.snapshots, max: maxFor(req) };
  }

  @Post() @HttpCode(202)
  async create(@Req() req: AuthedRequest, @Headers('idempotency-key') header: string | undefined, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    const fields: Record<string, string> = {};
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._:()-]{0,79}$/u.test(name)) fields.name = 'INVALID_SNAPSHOT_NAME';
    if (description.length > 500) fields.description = 'TOO_LONG';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    return this.start(req, header, id, 'snapshot_create', { name, description }, async (s) => {
      const out = await callAdapter<{ snapshots: Snapshot[] }>('/v1/vm/snapshots', { ...(await target(s.pool_id)), vm: s.vm_moref }, 30_000);
      if (out.snapshots.length >= maxFor(req)) throw apiError(409, 'SNAPSHOT_LIMIT', 'Remove a snapshot first', { name: 'SNAPSHOT_LIMIT' });
    });
  }

  @Post(':sid/revert') @HttpCode(202)
  revert(@Req() req: AuthedRequest, @Headers('idempotency-key') header: string | undefined, @Param('id', ParseUUIDPipe) id: string, @Param('sid') sid: string) {
    return this.start(req, header, id, 'snapshot_revert', { snapshot: snapshotId(sid) }, async (s, params) => { params.powerOn = s.power_state === 'poweredOn'; });
  }

  @Delete(':sid') @HttpCode(202)
  remove(@Req() req: AuthedRequest, @Headers('idempotency-key') header: string | undefined, @Param('id', ParseUUIDPipe) id: string, @Param('sid') sid: string) {
    return this.start(req, header, id, 'snapshot_delete', { snapshot: snapshotId(sid) });
  }

  private async start(req: AuthedRequest, header: string | undefined, id: string, kind: Kind, params: Record<string, unknown>,
    check?: (s: Record<string, string>, params: Record<string, unknown>) => Promise<void>) {
    const key = idempotencyKey(header, req.user.id);
    const requestHash = hashOf({ id, kind, ...params });
    const earlier = await replay(key, requestHash);
    if (earlier) return earlier;
    const s = await findServer(req, id, true);
    await customerMay(req, 'snapshots');
    ready(s);
    await check?.(s, params);
    return { serverId: id, operation: await startOperation(req, s, kind, key, requestHash, params) };
  }
}

const snapshotId = (sid: string) => {
  if (!/^snapshot-\d{1,12}$/.test(sid)) throw apiError(404, 'SNAPSHOT_NOT_FOUND', 'Unknown snapshot');
  return sid;
};
