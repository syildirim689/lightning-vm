// Hetzner-style firewalls: a customer's named rule list, attached to up to 5 of their servers.
// Rules here are the source of truth; every change bumps the attached servers' firewall_version and queues
// a job. The worker writes the current rules to VMware (a distributed-port traffic filter) and records the
// version it applied. Inbound: everything not allowed is dropped. Outbound: open unless out rules exist.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Queue } from 'bullmq';
import { isIP } from 'node:net';
import type { PoolClient } from 'pg';
import { pool, redis } from './db';
import { apiError } from './errors';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { can } from './permissions';

export type Rule = { direction: 'in' | 'out'; protocol: string; port: string | null; ips: string[]; description: string };
const protocols = ['tcp', 'udp', 'icmp', 'esp', 'gre'];
export const limits = { rulesPerFirewall: 50, ipsPerRule: 100, firewallsPerServer: 5 };

const queue = new Queue('firewalls', { connection: redis });

// Bumps the version of each server (inside the caller's transaction); queue the result after COMMIT so the
// worker never reads rules older than the version it is asked to apply.
async function bumpFirewalls(serverIds: string[], db: Pick<PoolClient, 'query'>) {
  if (!serverIds.length) return [];
  const { rows } = await db.query(`UPDATE servers SET firewall_version = firewall_version + 1, updated_at = now()
    WHERE id = ANY($1::uuid[]) AND state <> 'deleted' RETURNING id, firewall_version`, [serverIds]);
  return rows as { id: string; firewall_version: number }[];
}

// One job per (server, version); the worker runs them one at a time and always applies the server's current
// rules, so their order does not matter.
async function queueFirewalls(rows: { id: string; firewall_version: number }[]) {
  for (const r of rows) {
    await queue.add('apply', { serverId: r.id }, { jobId: `fw-${r.id}-${r.firewall_version}`, attempts: 5, backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true, removeOnFail: true }).catch(() => undefined); // the worker's recovery scan finds it otherwise
  }
}

export const syncFirewalls = async (serverIds: string[]) => queueFirewalls(await bumpFirewalls(serverIds, pool));

function cidr(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const [addr, bits, extra] = value.trim().split('/');
  const v = isIP(addr);
  if (!v || extra !== undefined) return null;
  const max = v === 4 ? 32 : 128;
  const n = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : -1;
  return n >= 0 && n <= max ? `${addr}/${n}` : null;
}

function port(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(String(value).trim());
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2] ?? m[1]);
  return a >= 1 && b <= 65535 && a <= b ? (a === b ? String(a) : `${a}-${b}`) : null;
}

// Field codes are translated by the web UI; keys point at the rule ("rules.3.port").
export function readRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { rules: 'INVALID_VALUE' });
  if (value.length > limits.rulesPerFirewall) throw apiError(400, 'VALIDATION_FAILED', 'Too many rules', { rules: 'TOO_MANY_RULES' });
  const fields: Record<string, string> = {};
  const rules = value.map((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const direction = r.direction === 'out' ? 'out' : r.direction === 'in' ? 'in' : (fields[`rules.${i}.direction`] = 'INVALID_VALUE', 'in');
    const protocol = protocols.includes(String(r.protocol)) ? String(r.protocol) : (fields[`rules.${i}.protocol`] = 'INVALID_VALUE', 'tcp');
    let p: string | null = null;
    if (protocol === 'tcp' || protocol === 'udp') p = port(r.port) ?? (fields[`rules.${i}.port`] = 'INVALID_PORT', null);
    const list = Array.isArray(r.ips) ? r.ips : [];
    const ips = [...new Set(list.map(cidr))];
    if (!list.length || list.length > limits.ipsPerRule || ips.includes(null)) fields[`rules.${i}.ips`] = 'INVALID_NETWORK';
    const description = typeof r.description === 'string' ? r.description.trim().slice(0, 255) : '';
    return { direction, protocol, port: p, ips: ips.filter((x): x is string => !!x), description } as Rule;
  });
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return rules;
}

function readName(value: unknown) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 64) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { name: name ? 'TOO_LONG' : 'REQUIRED' });
  return name;
}

// Owners act on their firewalls; staff with servers.manage_all on any (servers.view_all: read only).
async function findFirewall(req: AuthedRequest, id: string, manage: boolean) {
  const staff = can(req.user.permissions, 'servers.manage_all') || (!manage && can(req.user.permissions, 'servers.view_all'));
  if (manage && !staff && !can(req.user.permissions, 'firewalls.manage')) throw apiError(403, 'FORBIDDEN', 'Permission required');
  const { rows: [f] } = await pool.query('SELECT * FROM firewalls WHERE id = $1 AND (owner_id = $2 OR $3)', [id, req.user.id, staff]);
  if (!f) throw apiError(404, 'NOT_FOUND', 'Unknown firewall');
  return f;
}

// Servers to attach: the firewall owner's, alive, on a connection that can enforce firewalls, below the limit.
async function checkServers(client: Pick<PoolClient, 'query'>, ownerId: string, serverIds: string[], firewallId?: string) {
  const { rows } = await client.query(`SELECT s.id, c.operations->>'firewall' AS supported,
      (SELECT count(*)::int FROM firewall_servers fs WHERE fs.server_id = s.id AND fs.firewall_id IS DISTINCT FROM $3) AS attached
    FROM servers s JOIN resource_pools p ON p.id = s.pool_id JOIN vmware_connections c ON c.id = p.connection_id
    WHERE s.id = ANY($1::uuid[]) AND s.owner_id = $2 AND s.state NOT IN ('deleted', 'deleting') FOR UPDATE OF s`, [serverIds, ownerId, firewallId ?? null]);
  if (rows.length !== new Set(serverIds).size) throw apiError(404, 'NOT_FOUND', 'Unknown server', { serverIds: 'NOT_AVAILABLE' });
  if (rows.some((r) => r.supported !== 'true')) throw apiError(409, 'FIREWALL_NOT_SUPPORTED', 'This location cannot enforce firewalls (needs vCenter with a distributed switch)');
  if (rows.some((r) => r.attached >= limits.firewallsPerServer)) throw apiError(409, 'FIREWALL_LIMIT', `A server can have at most ${limits.firewallsPerServer} firewalls`);
}

const status = `CASE WHEN s.firewall_applied_version >= s.firewall_version THEN 'applied' WHEN s.firewall_error IS NOT NULL THEN 'failed' ELSE 'pending' END`;
const view = (f: Record<string, unknown>) => ({ id: f.id, name: f.name, rules: f.rules, ownerId: f.owner_id, createdAt: f.created_at, updatedAt: f.updated_at });

@Controller() @UseGuards(SessionGuard)
export class FirewallsController {
  @Get('firewalls')
  async list(@Req() req: AuthedRequest, @Query('scope') scope?: string, @Query('serverId') serverId?: string) {
    const all = scope === 'all' && can(req.user.permissions, 'servers.view_all');
    const { rows } = await pool.query(`SELECT f.*, u.email AS owner_email,
        COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'status', ${status}) ORDER BY s.name)
          FROM firewall_servers fs JOIN servers s ON s.id = fs.server_id WHERE fs.firewall_id = f.id AND s.state <> 'deleted'), '[]') AS servers
      FROM firewalls f JOIN users u ON u.id = f.owner_id
      WHERE ($2 OR f.owner_id = $1) AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM firewall_servers x WHERE x.firewall_id = f.id AND x.server_id = $3))
      ORDER BY f.name`, [req.user.id, all, serverId && /^[0-9a-f-]{36}$/.test(serverId) ? serverId : null]);
    return { firewalls: rows.map((f) => ({ ...view(f), ownerEmail: f.owner_email, servers: f.servers })), limits };
  }

  @Post('firewalls') @HttpCode(201)
  async create(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    if (!can(req.user.permissions, 'firewalls.manage')) throw apiError(403, 'FORBIDDEN', 'Permission required');
    const name = readName(body?.name);
    const rules = readRules(body?.rules ?? []);
    const serverIds = Array.isArray(body?.serverIds) ? body.serverIds.map(String) : [];
    const client = await pool.connect();
    let bumped: Awaited<ReturnType<typeof bumpFirewalls>> = [];
    try {
      await client.query('BEGIN');
      const { rows: [f] } = await client.query('INSERT INTO firewalls (owner_id, name, rules) VALUES ($1, $2, $3) RETURNING *', [req.user.id, name, JSON.stringify(rules)]);
      if (serverIds.length) {
        await checkServers(client, req.user.id, serverIds, f.id);
        await client.query('INSERT INTO firewall_servers (firewall_id, server_id) SELECT $1, unnest($2::uuid[])', [f.id, serverIds]);
        bumped = await bumpFirewalls(serverIds, client);
      }
      await client.query('COMMIT');
      await queueFirewalls(bumped);
      await audit(req, 'firewall.create', 'success', req.user.id, { firewallId: f.id, rules: rules.length, servers: serverIds.length });
      return view(f);
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { constraint?: string }).constraint === 'firewalls_owner_id_name_key') throw apiError(409, 'VALIDATION_FAILED', 'Name taken', { name: 'NAME_TAKEN' });
      throw err;
    } finally { client.release(); }
  }

  @Get('firewalls/:id')
  async detail(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const f = await findFirewall(req, id, false);
    const { rows: servers } = await pool.query(`SELECT s.id, s.name, s.state, host(a.address) AS address, ${status} AS status, s.firewall_error AS "errorCode",
        s.firewall_applied_at AS "appliedAt" FROM firewall_servers fs JOIN servers s ON s.id = fs.server_id
        LEFT JOIN ip_allocations a ON a.server_id = s.id AND a.kind = 'primary' WHERE fs.firewall_id = $1 AND s.state <> 'deleted' ORDER BY s.name`, [id]);
    return { ...view(f), servers, limits };
  }

  @Put('firewalls/:id')
  async update(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const f = await findFirewall(req, id, true);
    const name = body?.name === undefined ? f.name : readName(body.name);
    const rules = body?.rules === undefined ? f.rules : readRules(body.rules);
    const { rows: [u] } = await pool.query('UPDATE firewalls SET name = $2, rules = $3, updated_at = now() WHERE id = $1 RETURNING *', [id, name, JSON.stringify(rules)])
      .catch((err) => { if (err.constraint === 'firewalls_owner_id_name_key') throw apiError(409, 'VALIDATION_FAILED', 'Name taken', { name: 'NAME_TAKEN' }); throw err; });
    if (body?.rules !== undefined) {
      const { rows } = await pool.query('SELECT server_id FROM firewall_servers WHERE firewall_id = $1', [id]);
      await syncFirewalls(rows.map((r) => r.server_id));
    }
    await audit(req, 'firewall.update', 'success', req.user.id, { firewallId: id, rules: rules.length });
    return view(u);
  }

  // Like Hetzner: a firewall still applied to servers cannot be deleted; detach it first.
  @Delete('firewalls/:id') @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await findFirewall(req, id, true);
    const { rows: [n] } = await pool.query("SELECT count(*)::int AS n FROM firewall_servers fs JOIN servers s ON s.id = fs.server_id WHERE fs.firewall_id = $1 AND s.state <> 'deleted'", [id]);
    if (n.n) throw apiError(409, 'FIREWALL_IN_USE', 'Detach the firewall from its servers first');
    await pool.query('DELETE FROM firewalls WHERE id = $1', [id]);
    await audit(req, 'firewall.delete', 'success', req.user.id, { firewallId: id });
  }

  @Post('firewalls/:id/servers') @HttpCode(200)
  async attach(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const f = await findFirewall(req, id, true);
    const serverIds = Array.isArray(body?.serverIds) ? [...new Set(body.serverIds.map(String))] : [];
    if (!serverIds.length || serverIds.some((s) => !/^[0-9a-f-]{36}$/.test(s))) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { serverIds: 'REQUIRED' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await checkServers(client, f.owner_id, serverIds, id);
      const { rows } = await client.query('INSERT INTO firewall_servers (firewall_id, server_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING RETURNING server_id', [id, serverIds]);
      const bumped = await bumpFirewalls(rows.map((r) => r.server_id), client);
      await client.query('COMMIT');
      await queueFirewalls(bumped);
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    await audit(req, 'firewall.attach', 'success', req.user.id, { firewallId: id, serverIds });
    return this.detail(req, id);
  }

  @Delete('firewalls/:id/servers/:serverId')
  async detach(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('serverId', ParseUUIDPipe) serverId: string) {
    await findFirewall(req, id, true);
    const { rowCount } = await pool.query('DELETE FROM firewall_servers WHERE firewall_id = $1 AND server_id = $2', [id, serverId]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Not attached');
    await syncFirewalls([serverId]);
    await audit(req, 'firewall.detach', 'success', req.user.id, { firewallId: id, serverId });
    return this.detail(req, id);
  }

  // Applies the rules again (for example after a failure that has since been fixed in VMware).
  @Post('firewalls/:id/apply') @HttpCode(202)
  async apply(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await findFirewall(req, id, true);
    const { rows } = await pool.query('SELECT server_id FROM firewall_servers WHERE firewall_id = $1', [id]);
    await syncFirewalls(rows.map((r) => r.server_id));
    return { queued: rows.length };
  }
}
