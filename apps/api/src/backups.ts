// Backups of a server's disk on its location's backup datastore (migration 047). Taking, restoring and removing one are
// operations (task list, history, notifications); the worker does the VMware steps. A schedule takes them by itself and
// keeps the newest few (schedules.ts).
import { randomUUID } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { pool } from './db';
import { apiError } from './errors';
import { Can, PermissionGuard } from './rbac';
import { customerMay, findServer, hashOf, startOperation } from './servers';
import { getSettings } from './settings-store';

const columns = `id, kind, note, status, size_gb AS "sizeGb", error_code AS "errorCode", created_at AS "createdAt", finished_at AS "finishedAt"`;
const live = "status <> 'deleted'";

// Where a server's backups go: its location's backup datastore (on the same vCenter).
export async function backupTarget(poolId: string) {
  const { rows: [p] } = await pool.query('SELECT connection_id, backup_datastore_moref FROM resource_pools WHERE id = $1', [poolId]);
  return p?.backup_datastore_moref ? { connectionId: p.connection_id as string, datastore: p.backup_datastore_moref as string } : null;
}

// Starts a backup: the record first (its file name), then the operation; a refused operation takes the record back.
export async function startBackup(req: AuthedRequest, server: { id: string; owner_id: string; pool_id: string }, kind: 'manual' | 'scheduled', note: string, key: string) {
  const target = await backupTarget(server.pool_id);
  if (!target) throw apiError(409, 'BACKUPS_NOT_CONFIGURED', 'Backups are not set up for this location');
  const id = randomUUID();
  await pool.query(`INSERT INTO backups (id, server_id, owner_id, connection_id, datastore_moref, path, kind, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, server.id, server.owner_id, target.connectionId, target.datastore, `${server.id}/${id}.vmdk`, kind, note]);
  try {
    return { backupId: id, operation: await startOperation(req, server, 'backup_create', key, hashOf({ id: server.id, backup: id }), { backupId: id }) };
  } catch (err) {
    await pool.query('DELETE FROM backups WHERE id = $1', [id]);
    throw err;
  }
}

@Controller('servers/:id/backups') @UseGuards(SessionGuard)
export class BackupsController {
  @Get()
  async list(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id);
    const { rows } = await pool.query(`SELECT ${columns} FROM backups WHERE server_id = $1 AND ${live} ORDER BY created_at DESC`, [id]);
    return { backups: rows, max: (await getSettings('servers')).backups?.maxPerServer ?? 7, available: !!(await backupTarget(s.pool_id)) };
  }

  @Post() @HttpCode(202)
  async create(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const s = await findServer(req, id, true);
    await customerMay(req, 'backups');
    if (!['ready', 'error'].includes(s.state) || !s.vm_moref) throw apiError(409, 'INVALID_SERVER_STATE', 'Not possible in this state');
    const max = (await getSettings('servers')).backups?.maxPerServer ?? 7;
    const { rows: [n] } = await pool.query(`SELECT count(*)::int AS n FROM backups WHERE server_id = $1 AND status IN ('pending', 'running', 'ready')`, [id]);
    if (n.n >= max) throw apiError(409, 'BACKUP_LIMIT', 'Remove an older backup first');
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 120) : '';
    const out = await startBackup(req, s, 'manual', note, `backup:${id}:${randomUUID()}`);
    await audit(req, 'server.backup_started', 'success', req.user.id, { serverId: id, backupId: out.backupId });
    return out;
  }

  // Restoring replaces everything on the disk: the caller repeats the server's name. The server is stopped, its disk
  // replaced, and started again if it ran.
  @Post(':bid/restore') @HttpCode(202)
  async restore(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('bid', ParseUUIDPipe) bid: string, @Body() body: Record<string, unknown>) {
    const s = await findServer(req, id, true);
    await customerMay(req, 'backups');
    if (body?.confirm !== s.name) throw apiError(400, 'VALIDATION_FAILED', 'Confirmation required', { confirm: 'CONFIRMATION_MISMATCH' });
    const { rows: [b] } = await pool.query("SELECT id FROM backups WHERE id = $1 AND server_id = $2 AND status = 'ready'", [bid, id]);
    if (!b) throw apiError(404, 'NOT_FOUND', 'Unknown backup');
    if (s.state !== 'ready' || !s.vm_moref) throw apiError(409, 'INVALID_SERVER_STATE', 'Not possible in this state');
    const operation = await startOperation(req, s, 'backup_restore', `restore:${bid}:${randomUUID()}`, hashOf({ id, restore: bid }), { backupId: bid, powerOn: s.power_state === 'poweredOn' });
    await audit(req, 'server.backup_restore', 'success', req.user.id, { serverId: id, backupId: bid });
    return { operation };
  }

  @Delete(':bid') @HttpCode(202)
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('bid', ParseUUIDPipe) bid: string) {
    const s = await findServer(req, id, true);
    await customerMay(req, 'backups');
    const { rows: [b] } = await pool.query("SELECT id FROM backups WHERE id = $1 AND server_id = $2 AND status IN ('ready', 'failed')", [bid, id]);
    if (!b) throw apiError(404, 'NOT_FOUND', 'Unknown backup');
    const operation = await startOperation(req, s, 'backup_delete', `backup-delete:${bid}:${randomUUID()}`, hashOf({ id, remove: bid }), { backupId: bid });
    await audit(req, 'server.backup_deleted', 'success', req.user.id, { serverId: id, backupId: bid });
    return { operation };
  }
}

@Controller('admin') @UseGuards(PermissionGuard)
export class BackupsAdminController {
  // Every backup with its server and owner, newest first, and the space they take per location.
  @Get('backups') @Can('servers.view_all')
  async all() {
    const { rows } = await pool.query(`SELECT b.id, b.kind, b.status, b.size_gb AS "sizeGb", b.created_at AS "createdAt", b.error_code AS "errorCode", s.id AS "serverId", s.name AS "serverName",
        u.email, p.name AS "poolName" FROM backups b JOIN servers s ON s.id = b.server_id JOIN users u ON u.id = b.owner_id JOIN resource_pools p ON p.id = s.pool_id
      WHERE b.${live} ORDER BY b.created_at DESC LIMIT 500`);
    const { rows: usage } = await pool.query(`SELECT p.id AS "poolId", p.name, p.backup_datastore_moref AS datastore, d.name AS "datastoreName", d.free_bytes::float8 AS "freeBytes",
        coalesce(sum(b.size_gb) FILTER (WHERE b.status = 'ready'), 0)::int AS "usedGb", count(b.*) FILTER (WHERE b.status = 'ready')::int AS count
      FROM resource_pools p LEFT JOIN vmware_datastores d ON d.connection_id = p.connection_id AND d.moref = p.backup_datastore_moref
      LEFT JOIN servers s ON s.pool_id = p.id LEFT JOIN backups b ON b.server_id = s.id GROUP BY p.id, d.name, d.free_bytes ORDER BY p.name`);
    return { backups: rows, locations: usage };
  }

  // A location's backup datastore: any datastore of its vCenter (another site's NFS store keeps backups apart). Empty: none.
  @Put('pools/:id/backup') @Can('catalog.manage')
  async setTarget(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const moref = typeof body?.datastoreMoref === 'string' && body.datastoreMoref ? body.datastoreMoref : null;
    if (moref) {
      const { rowCount } = await pool.query('SELECT 1 FROM vmware_datastores d JOIN resource_pools p ON p.connection_id = d.connection_id WHERE p.id = $1 AND d.moref = $2', [id, moref]);
      if (!rowCount) throw apiError(400, 'VALIDATION_FAILED', 'Unknown datastore', { datastoreMoref: 'NOT_AVAILABLE' });
    }
    const { rowCount } = await pool.query('UPDATE resource_pools SET backup_datastore_moref = $2, updated_at = now() WHERE id = $1', [id, moref]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown pool');
    await audit(req, 'catalog.pool_backup', 'success', req.user.id, { id, datastore: moref });
    return { id, datastoreMoref: moref };
  }
}
