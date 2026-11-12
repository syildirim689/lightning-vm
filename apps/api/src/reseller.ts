// Resellers (migration 048): an account the admin gives an allocation (servers, vCPU, memory, disk, customers) and a
// discount. The reseller opens customer accounts, orders and manages servers for them; everything the reseller and
// their customers run counts against the allocation, and their servers are billed to the reseller at the discount.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { getAuth } from './better-auth';
import { pool } from './db';
import { apiError } from './errors';
import { permissionsOf, splitRoles } from './permissions';
import { Can, PermissionGuard } from './rbac';
import { fingerprint, sshKeyPattern } from './smart-rules';
import { ServersController } from './servers';

type Db = typeof pool | PoolClient;
export type Reseller = { id: string; discountPct: number; maxCustomers: number | null; maxServers: number | null; maxVcpu: number | null; maxMemoryMb: number | null; maxDiskGb: number | null };

const row = (r: Record<string, unknown>): Reseller => ({ id: String(r.user_id), discountPct: Number(r.discount_pct), maxCustomers: r.max_customers as number | null, maxServers: r.max_servers as number | null,
  maxVcpu: r.max_vcpu as number | null, maxMemoryMb: r.max_memory_mb as number | null, maxDiskGb: r.max_disk_gb as number | null });

// The active reseller a user's servers belong to: their own reseller, or themselves when they are one.
export async function resellerOf(userId: string, db: Db = pool): Promise<Reseller | null> {
  const { rows: [r] } = await db.query(`SELECT r.* FROM resellers r JOIN users u ON r.user_id = coalesce(u.reseller_id, u.id) WHERE u.id = $1 AND r.active`, [userId]);
  return r ? row(r) : null;
}
const activeReseller = async (userId: string) => {
  const { rows: [r] } = await pool.query('SELECT * FROM resellers WHERE user_id = $1 AND active', [userId]);
  if (!r) throw apiError(403, 'NOT_A_RESELLER', 'This account is not a reseller');
  return row(r);
};

// What the reseller and all their customers run now (servers not deleted).
export async function resellerUsage(id: string, db: Db = pool) {
  const { rows: [u] } = await db.query(`SELECT count(*)::int AS servers, coalesce(sum(s.vcpu), 0)::int AS vcpu, coalesce(sum(s.memory_mb), 0)::int AS "memoryMb", coalesce(sum(s.disk_gb), 0)::int AS "diskGb",
      coalesce(sum(s.price_monthly), 0)::text AS monthly, mode() WITHIN GROUP (ORDER BY s.currency) AS currency
      FROM servers s JOIN users o ON o.id = s.owner_id WHERE s.state <> 'deleted' AND (o.id = $1 OR o.reseller_id = $1)`, [id]);
  // `currency`: the one most of these servers are priced in (null with no servers), for showing `monthly`.
  return u as { servers: number; vcpu: number; memoryMb: number; diskGb: number; monthly: string; currency: string | null };
}

// Whether `more` (a new server, or a resize's increase) still fits the reseller's allocation; throws the limits it passes.
export async function checkResellerRoom(r: Reseller, more: { servers: number; vcpu: number; memoryMb: number; diskGb: number }, db: Db = pool) {
  const u = await resellerUsage(r.id, db);
  const over = [
    r.maxServers !== null && u.servers + more.servers > r.maxServers && 'servers',
    r.maxVcpu !== null && u.vcpu + more.vcpu > r.maxVcpu && 'vcpu',
    r.maxMemoryMb !== null && u.memoryMb + more.memoryMb > r.maxMemoryMb && 'memoryMb',
    r.maxDiskGb !== null && u.diskGb + more.diskGb > r.maxDiskGb && 'diskGb',
  ].filter(Boolean) as string[];
  if (over.length) throw apiError(409, 'RESELLER_ALLOCATION_EXCEEDED', 'The reseller allocation is used up', Object.fromEntries(over.map((o) => [o, 'RESELLER_ALLOCATION_EXCEEDED'])));
}

// The reseller's price: the catalog price less their discount, to the cent.
export const discounted = (monthly: string, pct: number) => (Math.round(Number(monthly) * (100 - pct)) / 100).toFixed(2);

const customerColumns = `u.id, u.email, u.name, u.created_at AS "createdAt", u.last_seen_at AS "lastSeenAt",
  (SELECT count(*)::int FROM servers s WHERE s.owner_id = u.id AND s.state <> 'deleted') AS servers,
  (SELECT coalesce(sum(s.price_monthly), 0)::text FROM servers s WHERE s.owner_id = u.id AND s.state <> 'deleted') AS monthly,
  (SELECT mode() WITHIN GROUP (ORDER BY s.currency) FROM servers s WHERE s.owner_id = u.id AND s.state <> 'deleted') AS currency`;

@Controller('reseller') @UseGuards(SessionGuard)
export class ResellerController {
  // Everyone may ask (the menu does): not a reseller answers with no allocation rather than an error.
  @Get('summary')
  async summary(@Req() req: AuthedRequest) {
    const { rows: [own] } = await pool.query('SELECT * FROM resellers WHERE user_id = $1 AND active', [req.user.id]);
    if (!own) return { allocation: null };
    const r = row(own);
    const { rows: [c] } = await pool.query('SELECT count(*)::int AS n FROM users WHERE reseller_id = $1', [r.id]);
    return { allocation: r, usage: { ...(await resellerUsage(r.id)), customers: c.n } };
  }

  // The brand a signed-in person sees: their reseller's (for a reseller's customer, or the reseller), if one is set.
  @Get('brand')
  async brand(@Req() req: AuthedRequest) {
    const { rows: [b] } = await pool.query(`SELECT r.brand_name AS name, r.brand_accent AS accent FROM resellers r JOIN users u ON r.user_id = coalesce(u.reseller_id, u.id)
      WHERE u.id = $1 AND r.active AND r.brand_name IS NOT NULL`, [req.user.id]);
    return b ?? {};
  }

  @Put('brand')
  async setBrand(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const r = await activeReseller(req.user.id);
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : null;
    const accent = typeof body?.accent === 'string' && /^#[0-9a-f]{6}$/i.test(body.accent) ? body.accent.toLowerCase() : null;
    if (body?.accent && !accent) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { accent: 'INVALID_VALUE' });
    await pool.query('UPDATE resellers SET brand_name = $2, brand_accent = $3, updated_at = now() WHERE user_id = $1', [r.id, name, accent]);
    await audit(req, 'reseller.brand', 'success', req.user.id, { name, accent });
    return { name, accent };
  }

  @Get('customers')
  async customers(@Req() req: AuthedRequest) {
    const r = await activeReseller(req.user.id);
    const { rows } = await pool.query(`SELECT ${customerColumns} FROM users u WHERE u.reseller_id = $1 ORDER BY u.created_at DESC`, [r.id]);
    return { customers: rows };
  }

  // A customer account of the reseller: they set their password with "forgot password" (or the reseller manages for them).
  @Post('customers') @HttpCode(201)
  async addCustomer(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const r = await activeReseller(req.user.id);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { email: 'INVALID_EMAIL' });
    const { rows: [c] } = await pool.query('SELECT count(*)::int AS n FROM users WHERE reseller_id = $1', [r.id]);
    if (r.maxCustomers !== null && c.n >= r.maxCustomers) throw apiError(409, 'RESELLER_ALLOCATION_EXCEEDED', 'The customer limit is reached', { email: 'RESELLER_ALLOCATION_EXCEEDED' });
    if ((await pool.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount) throw apiError(409, 'VALIDATION_FAILED', 'This e-mail has an account', { email: 'EMAIL_TAKEN' });
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const { user } = await getAuth().api.createUser({ body: { email, password: randomBytes(24).toString('base64url'), name, role: 'user', data: { locale: req.user.locale } } });
    await pool.query('UPDATE users SET reseller_id = $2, email_verified = true WHERE id = $1', [user.id, r.id]);
    await audit(req, 'reseller.customer_created', 'success', req.user.id, { target: user.id });
    return { id: user.id };
  }

  @Get('customers/:id')
  async customer(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const r = await activeReseller(req.user.id);
    const { rows: [c] } = await pool.query(`SELECT ${customerColumns} FROM users u WHERE u.id = $1 AND u.reseller_id = $2`, [id, r.id]);
    if (!c) throw apiError(404, 'NOT_FOUND', 'Unknown customer');
    const { rows: servers } = await pool.query(`SELECT s.id, s.name, s.state, s.power_state AS "powerState", s.vcpu, s.memory_mb AS "memoryMb", s.disk_gb AS "diskGb", s.price_monthly::text AS "priceMonthly",
        trim(s.currency) AS currency, (SELECT host(a.address) FROM ip_allocations a WHERE a.server_id = s.id AND a.kind = 'primary') AS address
      FROM servers s WHERE s.owner_id = $1 AND s.state <> 'deleted' ORDER BY s.name`, [id]);
    return { customer: c, servers };
  }

  // Orders a server for the customer (theirs; billed to the reseller at the discount). sshKey: a public key for them.
  @Post('customers/:id/servers') @HttpCode(202)
  async order(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const r = await activeReseller(req.user.id);
    const { rows: [u] } = await pool.query('SELECT id, email, name, role, locale FROM users WHERE id = $1 AND reseller_id = $2', [id, r.id]);
    if (!u) throw apiError(404, 'NOT_FOUND', 'Unknown customer');
    let sshKeyIds: string[] = [];
    // sshKeyId: one of the reseller's own saved keys, copied to the customer; otherwise sshKey, a pasted public key.
    let key = typeof body?.sshKey === 'string' ? body.sshKey.trim() : '';
    if (!key && typeof body?.sshKeyId === 'string' && body.sshKeyId) {
      const { rows: [mine] } = await pool.query('SELECT public_key FROM ssh_keys WHERE id::text = $1 AND owner_id = $2', [body.sshKeyId, req.user.id]);
      if (!mine) throw apiError(400, 'VALIDATION_FAILED', 'Unknown key', { sshKeyId: 'INVALID_SSH_KEY' });
      key = String(mine.public_key).trim();
    }
    if (!sshKeyPattern.test(key)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid key', { sshKey: 'INVALID_SSH_KEY' });
    const { rows: [k] } = await pool.query(`INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, $2, $3, $4)
      ON CONFLICT (owner_id, fingerprint) DO UPDATE SET name = ssh_keys.name RETURNING id`, [id, 'reseller', key, fingerprint(key)]);
    sshKeyIds = [k.id];
    const owner = Object.assign(Object.create(req), { user: { id: u.id, email: u.email, name: u.name ?? '', roles: splitRoles(u.role), permissions: await permissionsOf(u.id, u.role),
      locale: u.locale === 'tr' ? 'tr' : 'en', timeZone: null, username: null, impersonatedBy: null, twoFactorEnabled: false, phoneNumber: null, phoneNumberVerified: false } });
    const out = await new ServersController().create(owner, `reseller-${randomUUID()}`, { ...body, sshKeyIds, billingCycle: 'monthly' });
    await audit(req, 'reseller.server_ordered', 'success', req.user.id, { target: id, serverId: out.serverId });
    return out;
  }
}

@Controller('admin/resellers') @UseGuards(PermissionGuard)
export class ResellersAdminController {
  @Get() @Can('users.view')
  async list() {
    const { rows } = await pool.query('SELECT r.*, u.email, u.name FROM resellers r JOIN users u ON u.id = r.user_id ORDER BY u.email');
    return { resellers: await Promise.all(rows.map(async (r) => ({ ...row(r), email: r.email, name: r.name, active: r.active, usage: await resellerUsage(r.user_id),
      customers: (await pool.query('SELECT count(*)::int AS n FROM users WHERE reseller_id = $1', [r.user_id])).rows[0].n }))) };
  }

  @Get(':id') @Can('users.view')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const { rows: [r] } = await pool.query('SELECT * FROM resellers WHERE user_id = $1', [id]);
    return r ? { reseller: { ...row(r), active: r.active }, usage: await resellerUsage(id) } : { reseller: null };
  }

  // Makes the account a reseller (or changes its allocation). Empty limits mean no limit.
  @Put(':id') @Can('users.manage')
  async save(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const fields: Record<string, string> = {};
    const lim = (k: string, max: number) => {
      const v = body?.[k];
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > max) { fields[k] = 'OUT_OF_RANGE'; return null; }
      return n;
    };
    const v = { maxCustomers: lim('maxCustomers', 100_000), maxServers: lim('maxServers', 100_000), maxVcpu: lim('maxVcpu', 1_000_000), maxMemoryMb: lim('maxMemoryMb', 1_000_000_000), maxDiskGb: lim('maxDiskGb', 1_000_000_000) };
    const discount = body?.discountPct === undefined || body.discountPct === '' ? 0 : Number(body.discountPct);
    if (!Number.isFinite(discount) || discount < 0 || discount > 90) fields.discountPct = 'OUT_OF_RANGE';
    const { rows: [u] } = await pool.query('SELECT reseller_id FROM users WHERE id = $1', [id]);
    if (!u) throw apiError(404, 'NOT_FOUND', 'Unknown user');
    if (u.reseller_id) fields.userId = 'CUSTOMER_OF_A_RESELLER';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    await pool.query(`INSERT INTO resellers (user_id, max_customers, max_servers, max_vcpu, max_memory_mb, max_disk_gb, discount_pct, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id) DO UPDATE SET max_customers = $2, max_servers = $3, max_vcpu = $4, max_memory_mb = $5, max_disk_gb = $6, discount_pct = $7, active = $8, updated_at = now()`,
    [id, v.maxCustomers, v.maxServers, v.maxVcpu, v.maxMemoryMb, v.maxDiskGb, discount, body?.active !== false]);
    await audit(req, 'reseller.saved', 'success', req.user.id, { target: id, ...v, discount });
    return { ok: true };
  }

  // No longer a reseller; their customers become ordinary accounts (their servers stay theirs).
  @Delete(':id') @HttpCode(204) @Can('users.manage')
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await pool.query('UPDATE users SET reseller_id = NULL WHERE reseller_id = $1', [id]);
    await pool.query('DELETE FROM resellers WHERE user_id = $1', [id]);
    await audit(req, 'reseller.removed', 'success', req.user.id, { target: id });
  }
}
