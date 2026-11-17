// Private networks (migration 051): a customer's isolated network in a location. Creating one makes its port group
// at once (a quick call); a server joins or leaves by an operation that adds or removes its NIC there. Addresses come
// from the network's subnet (.10 upwards); the guest sets the address on the new interface (the page shows how).
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { pool } from './db';
import { apiError } from './errors';
import { Can, PermissionGuard } from './rbac';
import { customerMay, findServer, hashOf, ownerWrite, startOperation } from './servers';
import { callAdapter, storedTarget } from './vmware';

const MAX_NETWORKS = 10;
const target = async (poolId: string) => {
  const { rows: [c] } = await pool.query('SELECT c.* FROM vmware_connections c JOIN resource_pools p ON p.connection_id = c.id WHERE p.id = $1', [poolId]);
  return storedTarget(c);
};
// A private subnet the customer chose, or 10.<n>.0.0/24 from the VLAN; only RFC 1918 ranges, /16 to /28.
function subnet(raw: unknown, vlan: number) {
  if (raw === undefined || raw === null || raw === '') return `10.${(vlan % 250) + 1}.0.0/24`;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(raw).trim());
  if (!m) return null;
  const [a, b, , , bits] = m.slice(1).map(Number);
  const privateRange = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  return privateRange && bits >= 16 && bits <= 28 && m.slice(1, 5).every((x) => Number(x) <= 255) ? String(raw).trim() : null;
}

@Controller('networks') @UseGuards(SessionGuard)
export class PrivateNetworksController {
  @Get()
  async list(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT n.id, n.name, n.cidr::text, n.vlan, n.pool_id AS "poolId", p.name AS "poolName", n.created_at AS "createdAt",
        coalesce((SELECT json_agg(json_build_object('serverId', m.server_id, 'name', s.name, 'address', host(m.address), 'mac', m.mac, 'status', m.status) ORDER BY m.address)
          FROM private_network_members m JOIN servers s ON s.id = m.server_id WHERE m.network_id = n.id), '[]') AS members
      FROM private_networks n JOIN resource_pools p ON p.id = n.pool_id WHERE n.owner_id = $1 ORDER BY n.created_at`, [req.user.id]);
    const { rows: pools } = await pool.query(`SELECT id, name, location FROM resource_pools WHERE active AND private_portgroup_moref IS NOT NULL ORDER BY name`);
    return { networks: rows, pools, max: MAX_NETWORKS };
  }

  @Post() @HttpCode(201)
  async create(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const fields: Record<string, string> = {};
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : (fields.name = 'REQUIRED', '');
    const { rows: [p] } = await pool.query('SELECT * FROM resource_pools WHERE id = $1 AND active AND private_portgroup_moref IS NOT NULL', [String(body?.poolId ?? '')]).catch(() => ({ rows: [] }));
    if (!p) fields.poolId = 'NOT_AVAILABLE';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    if ((await pool.query('SELECT 1 FROM private_networks WHERE owner_id = $1', [req.user.id])).rowCount! >= MAX_NETWORKS) throw apiError(409, 'LIMIT_REACHED', 'Too many networks');
    // The lowest free VLAN of the location's range.
    const { rows: [v] } = await pool.query(`SELECT g AS vlan FROM generate_series($2::int, $3::int) g WHERE NOT EXISTS (SELECT 1 FROM private_networks n WHERE n.pool_id = $1 AND n.vlan = g) ORDER BY g LIMIT 1`,
      [p.id, p.private_vlan_min, p.private_vlan_max]);
    if (!v) throw apiError(409, 'NO_FREE_VLAN', 'This location has no free private network left');
    const cidr = subnet(body?.cidr, v.vlan);
    if (!cidr) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { cidr: 'INVALID_PRIVATE_SUBNET' });
    const id = randomUUID();
    await pool.query('INSERT INTO private_networks (id, owner_id, pool_id, name, cidr, vlan) VALUES ($1, $2, $3, $4, $5, $6)', [id, req.user.id, p.id, name, cidr, v.vlan]);
    try {
      const out = await callAdapter<{ portgroup: string }>('/v1/network/create', { ...(await target(p.id)), reference: p.private_portgroup_moref, name: `lvm-net-${id}`, vlan: v.vlan }, 90_000);
      await pool.query('UPDATE private_networks SET portgroup_moref = $2 WHERE id = $1', [id, out.portgroup]);
    } catch (err) { await pool.query('DELETE FROM private_networks WHERE id = $1', [id]); throw err; }
    await audit(req, 'network.created', 'success', req.user.id, { networkId: id, vlan: v.vlan, cidr });
    return { id, cidr, vlan: v.vlan };
  }

  // Only an empty network can go.
  @Delete(':id') @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [n] } = await pool.query('SELECT * FROM private_networks WHERE id = $1 AND owner_id = $2', [id, req.user.id]);
    if (!n) throw apiError(404, 'NOT_FOUND', 'Unknown network');
    if ((await pool.query('SELECT 1 FROM private_network_members WHERE network_id = $1', [id])).rowCount) throw apiError(409, 'NETWORK_IN_USE', 'Remove its servers first');
    if (n.portgroup_moref) await callAdapter('/v1/network/delete', { ...(await target(n.pool_id)), portgroup: n.portgroup_moref }, 90_000);
    await pool.query('DELETE FROM private_networks WHERE id = $1', [id]);
    await audit(req, 'network.deleted', 'success', req.user.id, { networkId: id });
  }

  // A server of the same location joins: the next free address, then the operation that adds its NIC.
  @Post(':id/servers') @HttpCode(202)
  async join(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const { rows: [n] } = await pool.query('SELECT * FROM private_networks WHERE id = $1 AND owner_id = $2', [id, req.user.id]);
    if (!n) throw apiError(404, 'NOT_FOUND', 'Unknown network');
    const s = await findServer(req, String(body?.serverId ?? ''), true).catch(() => null);
    if (!s || s.owner_id !== req.user.id || s.pool_id !== n.pool_id) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { serverId: 'NOT_AVAILABLE' });
    await customerMay(req, 'power');
    if (s.state !== 'ready' || !s.vm_moref) throw apiError(409, 'INVALID_SERVER_STATE', 'Not possible in this state');
    const { rows: [a] } = await pool.query(`SELECT host(network($1::cidr) + g) AS address FROM generate_series(10, (2 ^ (32 - masklen($1::cidr)))::int - 2) g
      WHERE NOT EXISTS (SELECT 1 FROM private_network_members m WHERE m.network_id = $2 AND m.address = network($1::cidr) + g) ORDER BY g LIMIT 1`, [n.cidr, id]);
    if (!a) throw apiError(409, 'NETWORK_FULL', 'The network has no free address');
    try {
      // Only while the server is still this owner's (servers.ts ownerWrite): a hand-over refuses a server on a network.
      await ownerWrite(s, (db) => db.query('INSERT INTO private_network_members (network_id, server_id, address) VALUES ($1, $2, $3)', [id, s.id, a.address]));
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw apiError(409, 'ALREADY_MEMBER', 'The server is on this network already');
      throw err;
    }
    try {
      const operation = await startOperation(req, s, 'nic_add', `net:${id}:${s.id}:${randomUUID()}`, hashOf({ id: s.id, network: id }), { networkId: id });
      await audit(req, 'network.server_joined', 'success', req.user.id, { networkId: id, serverId: s.id });
      return { address: a.address, operation };
    } catch (err) { await pool.query('DELETE FROM private_network_members WHERE network_id = $1 AND server_id = $2', [id, s.id]); throw err; }
  }

  @Delete(':id/servers/:serverId') @HttpCode(202)
  async leave(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('serverId', ParseUUIDPipe) serverId: string) {
    const { rows: [m] } = await pool.query(`SELECT m.* FROM private_network_members m JOIN private_networks n ON n.id = m.network_id WHERE m.network_id = $1 AND m.server_id = $2 AND n.owner_id = $3`, [id, serverId, req.user.id]);
    if (!m) throw apiError(404, 'NOT_FOUND', 'Not on this network');
    const s = await findServer(req, serverId, true);
    if (m.status === 'failed' || !s.vm_moref) { await ownerWrite(s, (db) => db.query('DELETE FROM private_network_members WHERE network_id = $1 AND server_id = $2', [id, serverId])); return { removed: true }; }
    const operation = await startOperation(req, s, 'nic_remove', `net-leave:${id}:${serverId}:${randomUUID()}`, hashOf({ id: serverId, leave: id }), { networkId: id });
    await pool.query("UPDATE private_network_members SET status = 'leaving' WHERE network_id = $1 AND server_id = $2", [id, serverId]);
    await audit(req, 'network.server_left', 'success', req.user.id, { networkId: id, serverId });
    return { operation };
  }
}

@Controller('admin/pools') @UseGuards(PermissionGuard)
export class PrivateNetworkSettingsController {
  // Private networks in a location: a distributed port group whose switch carries them, and the VLANs they may use.
  @Put(':id/private-networks') @Can('catalog.manage')
  async save(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const moref = typeof body?.portgroupMoref === 'string' && body.portgroupMoref ? body.portgroupMoref : null;
    const min = Number(body?.vlanMin), max = Number(body?.vlanMax);
    const fields: Record<string, string> = {};
    if (moref) {
      if (!(await pool.query("SELECT 1 FROM vmware_networks n JOIN resource_pools p ON p.connection_id = n.connection_id WHERE p.id = $1 AND n.moref = $2 AND n.kind = 'distributed'", [id, moref])).rowCount) fields.portgroupMoref = 'NOT_AVAILABLE';
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 4094 || min > max) fields.vlanMin = 'OUT_OF_RANGE';
    }
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    const { rowCount } = await pool.query('UPDATE resource_pools SET private_portgroup_moref = $2, private_vlan_min = $3, private_vlan_max = $4, updated_at = now() WHERE id = $1',
      [id, moref, moref ? min : null, moref ? max : null]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown pool');
    await audit(req, 'catalog.pool_private_networks', 'success', req.user.id, { id, portgroup: moref, min, max });
    return { id, portgroupMoref: moref, vlanMin: moref ? min : null, vlanMax: moref ? max : null };
  }
}
