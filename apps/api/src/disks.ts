// Extra disks (migration 050): a customer adds disks beside the system disk where the location sells them (a price per GB
// and month). The server's monthly price grows by the disk's; the increase is invoiced for the rest of the period like a
// resize. Removing one deletes its data and lowers the price from the next period.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { billResize, resizeCharge } from './billing';
import { hourlyOf } from './billing-rules';
import { exceededQuota } from './capacity';
import { capacityOf, limitsFor, quotaExceeded, usageOf } from './catalog';
import { pool } from './db';
import { apiError } from './errors';
import { Can, PermissionGuard } from './rbac';
import { checkResellerRoom, discounted, resellerOf } from './reseller';
import { admitRoom, customerMay, findServer, hashOf, ownerWrite, refuseBilledElsewhere, repriced, startOperation } from './servers';

export const MAX_EXTRA_DISKS = 4;
const columns = `id, size_gb AS "sizeGb", price_monthly::text AS "priceMonthly", status, created_at AS "createdAt"`;

@Controller('servers/:id/disks') @UseGuards(SessionGuard)
export class DisksController {
  @Get()
  async list(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id);
    const { rows } = await pool.query(`SELECT ${columns} FROM server_disks WHERE server_id = $1 ORDER BY created_at`, [id]);
    const { rows: [p] } = await pool.query('SELECT extra_disk_price_gb::text AS price FROM resource_pools WHERE id = $1', [s.pool_id]);
    const reseller = await resellerOf(s.owner_id);
    const price = p?.price && reseller ? (Number(p.price) * (100 - reseller.discountPct) / 100).toFixed(4) : p?.price ?? null;
    return { disks: rows, pricePerGb: price, currency: s.currency.trim(), max: MAX_EXTRA_DISKS };
  }

  @Post() @HttpCode(202) @Can('server.resize')
  async add(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const s = await findServer(req, id, true);
    refuseBilledElsewhere(req, s); // nobody would bill the disk
    await customerMay(req, 'resize');
    if (s.state !== 'ready' || !s.vm_moref) throw apiError(409, 'INVALID_SERVER_STATE', 'Not possible in this state');
    // A data center's servers live inside its allocation and are paid with it: a disk beside that would be neither counted nor billed.
    if (s.vdc_id) throw apiError(409, 'VDC_SERVER', 'Change the virtual data center instead');
    const size = Number(body?.sizeGb);
    if (!Number.isInteger(size) || size < 1 || size > 16384) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { sizeGb: 'OUT_OF_RANGE' });
    const { rows: [p] } = await pool.query('SELECT * FROM resource_pools WHERE id = $1', [s.pool_id]);
    if (p.extra_disk_price_gb === null) throw apiError(409, 'EXTRA_DISKS_NOT_SOLD', 'This location does not sell extra disks');
    if ((await pool.query("SELECT 1 FROM server_disks WHERE server_id = $1 AND status <> 'failed'", [id])).rowCount! >= MAX_EXTRA_DISKS) throw apiError(409, 'DISK_LIMIT', 'Too many extra disks');
    // The location's free storage and the reseller's allocation, as for any disk: read here for an early refusal, and
    // decided where the disk is written, below (as the owner's quota is).
    if (size > (await capacityOf(p)).available.storageGb) throw apiError(409, 'CAPACITY_EXHAUSTED', 'Not enough storage in this location');
    const reseller = await resellerOf(s.owner_id);
    if (reseller) await checkResellerRoom(reseller, { servers: 0, vcpu: 0, memoryMb: 0, diskGb: size });
    const raw = (Math.round(size * Number(p.extra_disk_price_gb) * 100) / 100).toFixed(2);
    const price = reseller ? discounted(raw, reseller.discountPct) : raw;
    const diskId = randomUUID();
    // Only while the server is still this owner's (servers.ts ownerWrite); startOperation checks the same again.
    // The quota (the project's, else the account's) is counted and the disk added under the owner's lock, in one
    // transaction: two disks asked for at the same moment, on two servers of one account, used to be counted against
    // the same free room and could both pass.
    await ownerWrite(s, async (db) => {
      const quota = await limitsFor(s.owner_id, s.project_id ?? undefined);
      const over = exceededQuota({ ...quota, max_servers: null }, await usageOf(s.owner_id, s.project_id ?? undefined, db), { vcpu: 0, memoryMb: 0, diskGb: size });
      if (over.length) throw quotaExceeded(quota, over, { sizeGb: 'QUOTA_EXCEEDED' });
      // The location's storage and the reseller's allocation under their own locks (servers.ts, admitRoom): they are
      // counted across accounts, so two disks of two accounts were not kept apart by the owner's lock.
      await admitRoom(db, s as { owner_id: string; pool_id: string }, { vcpu: 0, memoryMb: 0, diskGb: size }, 'storage');
      await db.query('INSERT INTO server_disks (id, server_id, size_gb, price_monthly) VALUES ($1, $2, $3, $4)', [diskId, id, size, price]);
    }, true);
    let operation;
    try {
      operation = await startOperation(req, s, 'disk_add', `disk:${diskId}`, hashOf({ id, disk: diskId }), { diskId, sizeGb: size });
    } catch (err) { await pool.query('DELETE FROM server_disks WHERE id = $1', [diskId]); throw err; }
    // The server costs more from now on (an hourly one per hour, as a resize prices it); the rest of the period is invoiced like a resize.
    const before = s.price_monthly;
    const { rows: [n] } = await pool.query(`UPDATE servers SET price_monthly = price_monthly + $2, price_hourly = CASE WHEN billing_mode = 'hourly' THEN price_hourly + $3::numeric ELSE price_hourly END,
      updated_at = now() WHERE id = $1 RETURNING price_monthly::text AS p`, [id, price, hourlyOf(price)]);
    await repriced(id);
    const charge = await resizeCharge(id, before, n.p);
    const invoiceId = charge.chargeNow !== '0.00' ? await billResize({ ...s, owner_id: reseller?.id ?? s.owner_id }, charge.chargeNow, s.currency.trim(), { vcpu: s.vcpu, memoryMb: s.memory_mb, diskGb: s.disk_gb + size }) : null;
    await audit(req, 'server.disk_added', 'success', req.user.id, { serverId: id, diskId, sizeGb: size });
    return { diskId, operation, ...(invoiceId && { invoiceId }) };
  }

  // Deletes the disk and everything on it.
  @Delete(':diskId') @HttpCode(202) @Can('server.resize')
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('diskId', ParseUUIDPipe) diskId: string) {
    const s = await findServer(req, id, true);
    await customerMay(req, 'resize');
    const { rows: [d] } = await pool.query("SELECT * FROM server_disks WHERE id = $1 AND server_id = $2 AND status IN ('ready', 'failed')", [diskId, id]);
    if (!d) throw apiError(404, 'NOT_FOUND', 'Unknown disk');
    if (d.status === 'failed' || d.device_key === null) {
      // One statement, as the worker does for a disk that exists: the row and its share of the price go together, once.
      // Requests sent at the same time all read the row above; only the one whose DELETE removes it lowers the price.
      const { rowCount } = await ownerWrite(s, (db) => db.query(`WITH gone AS (DELETE FROM server_disks WHERE id = $2 AND server_id = $1 AND (status = 'failed' OR (status = 'ready' AND device_key IS NULL)) RETURNING price_monthly)
        UPDATE servers s SET price_monthly = greatest(0, s.price_monthly - gone.price_monthly),
          price_hourly = CASE WHEN s.billing_mode = 'hourly' AND s.price_hourly IS NOT NULL THEN greatest(0, s.price_hourly - $3::numeric) ELSE s.price_hourly END,
          updated_at = now() FROM gone WHERE s.id = $1`, [id, diskId, hourlyOf(String(d.price_monthly))]));
      if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown disk');
      await repriced(id);
      return { removed: true };
    }
    // "removing" before the operation is queued (a removal that fails at once puts "ready" back, and that must stand);
    // undone when the operation cannot start. hourlySubtract: what an hourly server costs less per hour once the disk is
    // gone; the worker lowers price_hourly by it in the statement that lowers the monthly price.
    await ownerWrite(s, (db) => db.query("UPDATE server_disks SET status = 'removing' WHERE id = $1", [diskId]));
    const operation = await startOperation(req, s, 'disk_remove', `disk-remove:${diskId}`, hashOf({ id, removeDisk: diskId }),
      { diskId, key: d.device_key, hourlySubtract: hourlyOf(String(d.price_monthly)) }).catch(async (err) => {
        await pool.query("UPDATE server_disks SET status = $2 WHERE id = $1 AND status = 'removing'", [diskId, d.status]);
        throw err;
      });
    await audit(req, 'server.disk_removed', 'success', req.user.id, { serverId: id, diskId });
    return { operation };
  }
}

@Controller('admin/pools') @UseGuards(PermissionGuard)
export class DiskPriceController {
  // The monthly price per GB of extra disks in this location (empty: not sold here).
  @Put(':id/extra-disks') @Can('catalog.manage')
  async setPrice(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const raw = body?.pricePerGb;
    const price = raw === null || raw === undefined || raw === '' ? null : String(raw).replace(',', '.');
    if (price !== null && !/^\d{1,6}(\.\d{1,4})?$/.test(price)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { pricePerGb: 'INVALID_AMOUNT' });
    const { rowCount } = await pool.query('UPDATE resource_pools SET extra_disk_price_gb = $2, updated_at = now() WHERE id = $1', [id, price]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown pool');
    await audit(req, 'catalog.pool_extra_disks', 'success', req.user.id, { id, price });
    return { id, pricePerGb: price };
  }
}
