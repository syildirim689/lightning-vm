// Taking over VMs made outside the panel: a VM from the discovered inventory becomes a server of a customer. The VM
// keeps running; it gets the managed name ("lvm-<server id>", which is how the panel finds it), its size is read from
// VMware, and its address (when given) is recorded from the location's IP pools. Billing adopts it like any server.
import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { audit, type AuthedRequest } from './auth';
import { pool } from './db';
import { apiError } from './errors';
import { Can, PermissionGuard } from './rbac';
import { callAdapter, storedTarget } from './vmware';

type Input = Record<string, unknown>;

@Controller('admin/import') @UseGuards(PermissionGuard)
export class ImportController {
  // Inventory VMs of a connection that are neither templates nor already the panel's (refresh the inventory first).
  @Get('candidates') @Can('servers.manage_all')
  async candidates(@Query('connectionId') connectionId: string) {
    if (!/^[0-9a-f-]{36}$/.test(connectionId ?? '')) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { connectionId: 'INVALID_VALUE' });
    const { rows } = await pool.query(`SELECT moref, name, power_state AS "powerState", cpu AS vcpu, memory_mb AS "memoryMb", guest,
        ceil(COALESCE(committed_bytes, 0) + COALESCE(uncommitted_bytes, 0))::float8 / 1073741824 AS "storageGb"
      FROM vmware_vms WHERE connection_id = $1 AND NOT template AND name NOT LIKE 'lvm-%' ORDER BY name`, [connectionId]);
    const { rows: pools } = await pool.query('SELECT id, name FROM resource_pools WHERE connection_id = $1 ORDER BY name', [connectionId]);
    return { vms: rows, pools };
  }

  @Post() @Can('servers.manage_all')
  async import(@Req() req: AuthedRequest, @Body() body: Input) {
    const fields: Record<string, string> = {};
    const name = typeof body?.name === 'string' && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(body.name) ? body.name : (fields.name = 'INVALID_HOSTNAME', '');
    const price = body?.priceMonthly === undefined || body.priceMonthly === '' ? '0' : String(body.priceMonthly);
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(price)) fields.priceMonthly = 'INVALID_AMOUNT';
    const { rows: [owner] } = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [String(body?.ownerEmail ?? '')]);
    if (!owner) fields.ownerEmail = 'NOT_AVAILABLE';
    const { rows: [rp] } = await pool.query('SELECT p.*, c.kind AS connection_kind FROM resource_pools p JOIN vmware_connections c ON c.id = p.connection_id WHERE p.id = $1', [String(body?.poolId ?? '')]).catch(() => ({ rows: [] }));
    if (!rp) fields.poolId = 'NOT_AVAILABLE';
    const { rows: [vm] } = rp ? await pool.query(`SELECT * FROM vmware_vms WHERE connection_id = $1 AND moref = $2 AND NOT template AND name NOT LIKE 'lvm-%'`, [rp.connection_id, String(body?.vmMoref ?? '')]) : { rows: [] };
    if (rp && !vm) fields.vmMoref = 'NOT_AVAILABLE';
    const { rows: [img] } = rp ? await pool.query('SELECT id FROM os_images WHERE id = $1 AND connection_id = $2', [String(body?.imageId ?? ''), rp.connection_id]).catch(() => ({ rows: [] })) : { rows: [] };
    if (rp && !img) fields.imageId = 'NOT_AVAILABLE';
    const address = typeof body?.address === 'string' && body.address.trim() ? body.address.trim() : null;
    const { rows: [ip] } = address && rp ? await pool.query(`SELECT i.id FROM ip_pools i WHERE i.pool_id = $1 AND $2::inet BETWEEN i.range_start AND i.range_end
        AND NOT EXISTS (SELECT 1 FROM ip_allocations a WHERE a.address = $2::inet)`, [rp.id, address]).catch(() => ({ rows: [] })) : { rows: [] };
    if (address && !ip) fields.address = 'NOT_AVAILABLE';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);

    // Recorded first (not yet ready), then renamed in VMware; if VMware refuses, the record goes again. No transaction
    // stays open while VMware is called.
    let id: string;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [s] } = await client.query(`INSERT INTO servers (owner_id, pool_id, image_id, name, vcpu, memory_mb, disk_gb, price_monthly, currency, state, power_state, ssh_public_keys)
        VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, 'provisioning', $9, '{}') RETURNING id`,
        [owner.id, rp.id, img.id, name, Math.max(1, vm.cpu ?? 1), Math.max(512, vm.memory_mb ?? 512), price, String(body?.currency ?? 'EUR').slice(0, 3).toUpperCase(), vm.power_state ?? 'unknown']);
      if (ip) await client.query("INSERT INTO ip_allocations (ip_pool_id, address, server_id, kind) VALUES ($1, $2, $3, 'primary')", [ip.id, address, s.id]);
      await client.query('COMMIT');
      id = s.id;
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { constraint?: string }).constraint === 'servers_owner_name_key') throw apiError(409, 'VALIDATION_FAILED', 'Name taken', { name: 'NAME_TAKEN' });
      if ((err as { constraint?: string }).constraint === 'ip_allocations_pkey') throw apiError(409, 'VALIDATION_FAILED', 'Address taken', { address: 'NOT_AVAILABLE' });
      throw err;
    } finally { client.release(); }
    let disk: number;
    try {
      disk = (await callAdapter<{ diskGb: number }>('/v1/vm/rename', { ...storedTarget(await connection(rp.connection_id)), vm: vm.moref, name: `lvm-${id}`, expectName: vm.name }, 60_000)).diskGb; // expectName: still the VM the inventory listed under this id
    } catch (err) {
      await pool.query('DELETE FROM servers WHERE id = $1', [id]);
      throw err;
    }
    await pool.query("UPDATE servers SET state = 'ready', vm_moref = $2, disk_gb = $3, guest_ready = $4, updated_at = now() WHERE id = $1", [id, vm.moref, Math.max(1, disk), vm.power_state === 'poweredOn']);
    await pool.query('UPDATE vmware_vms SET name = $3 WHERE connection_id = $1 AND moref = $2', [rp.connection_id, vm.moref, `lvm-${id}`]);
    await audit(req, 'server.imported', 'success', req.user.id, { serverId: id, vm: vm.moref, vmName: vm.name, owner: owner.id });
    return { serverId: id };
  }
}

async function connection(id: string) {
  const { rows: [c] } = await pool.query('SELECT * FROM vmware_connections WHERE id = $1', [id]);
  return c;
}
