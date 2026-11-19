// Resellers (migration 048): an account the admin gives an allocation (servers, vCPU, memory, disk, customers) and a
// discount. The reseller opens customer accounts, orders and manages servers for them; everything the reseller and
// their customers run counts against the allocation, and their servers are billed to the reseller at the discount.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { actingFor, audit, SessionGuard, type AuthedRequest } from './auth';
import { getAuth } from './better-auth';
import { directBilling } from './billing';
import { discounted, monthlyTotals, toCents, undiscounted } from './billing-rules';
import { revokeConsoles } from './console-revoke';
import { pool } from './db';
import { apiError } from './errors';
import { notify } from './notify';
import { permissionsOf, splitRoles } from './permissions';
import { Can, PermissionGuard } from './rbac';
import { fingerprint, sshKeyPattern } from './smart-rules';
import { enqueue, ServersController } from './servers';

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

// The reseller's price: the catalog price less their discount, to the cent (billing-rules.ts).
export { discounted };

export type ListPrice = { serverId: string; name: string; currency: string; from: string; to: string };
// The reseller's discount comes off the servers of a customer who stops being the reseller's (`serverIds`: those whose
// subscription the reseller paid, billing.ts directBilling). Only the price for what is invoiced from now on changes:
// the server's price, its extra disks' and the subscription's amount; nothing is charged for the period that runs (the
// reseller paid it), and the next renewal, or the first period nobody paid, is invoiced at the list price. `apply`
// false only tells (for the account page, before the customer decides). kept: servers whose list price cannot be told
// (undiscounted), which keep their price until staff look.
export async function listPrices(db: Db, customerId: string, serverIds: string[], pct: number, apply: boolean): Promise<{ changed: ListPrice[]; kept: string[] }> {
  const changed: ListPrice[] = [], kept: string[] = [];
  if (!serverIds.length || !(pct > 0)) return { changed, kept };
  const { rows } = await db.query(`SELECT s.id, s.name, s.price_monthly::text AS price, trim(s.currency) AS currency, s.vcpu, s.memory_mb, s.disk_gb, s.extra_ipv4, s.package_id, s.application_id,
      s.pool_id, s.vdc_id, s.external_source, s.billing_mode, rp.extra_ipv4_price::text AS ip_price, rp.extra_disk_price_gb::text AS disk_price
    FROM servers s JOIN resource_pools rp ON rp.id = s.pool_id WHERE s.owner_id = $1 AND s.id = ANY($2::uuid[]) AND s.state <> 'deleted' ORDER BY s.name ${apply ? 'FOR UPDATE OF s' : ''}`, [customerId, serverIds]);
  for (const s of rows) {
    // The shape's price, as an order prices it (catalog.ts, resolveOrder), in the server's currency.
    const { rows: [shape] } = s.vdc_id || s.external_source || s.billing_mode !== 'monthly' ? { rows: [] } : s.package_id
      ? await db.query('SELECT price_monthly::text AS monthly FROM packages WHERE id = $1 AND vcpu = $2 AND memory_mb = $3 AND disk_gb = $4 AND trim(currency) = $5', [s.package_id, s.vcpu, s.memory_mb, s.disk_gb, s.currency])
      : await db.query(`SELECT ($2::int * price_vcpu + $3::numeric / 1024 * price_memory_gb + $4::int * price_disk_gb)::numeric(12,2)::text AS monthly FROM custom_rules
          WHERE pool_id = $1 AND trim(currency) = $5`, [s.pool_id, s.vcpu, s.memory_mb, s.disk_gb, s.currency]);
    const { rows: [app] } = s.application_id ? await db.query('SELECT price_monthly::text AS monthly FROM applications WHERE id = $1', [s.application_id]) : { rows: [{ monthly: '0' }] };
    const { rows: disks } = await db.query('SELECT id, size_gb, price_monthly::text AS price FROM server_disks WHERE server_id = $1 ORDER BY created_at', [s.id]);
    let to: string | null = null;
    const diskList = disks.map((d) => (s.disk_price === null ? null : (Math.round(d.size_gb * Number(s.disk_price) * 100) / 100).toFixed(2)));
    if (shape && app && !diskList.includes(null)) {
      const { rows: [base] } = await db.query('SELECT ($1::numeric + $2::int * $3::numeric + $4::numeric)::numeric(12,2)::text AS monthly', [shape.monthly, s.extra_ipv4, s.ip_price, app.monthly]);
      to = undiscounted(s.price, pct, base.monthly, diskList as string[]);
    }
    if (to === null) { kept.push(s.id); continue; }
    if (toCents(to) === toCents(s.price)) continue;
    changed.push({ serverId: s.id, name: s.name, currency: s.currency, from: s.price, to });
    if (!apply) continue;
    await db.query('UPDATE servers SET price_monthly = $2, updated_at = now() WHERE id = $1', [s.id, to]);
    for (const [i, d] of disks.entries()) await db.query('UPDATE server_disks SET price_monthly = $2 WHERE id = $1', [d.id, diskList[i]]);
    await db.query("UPDATE subscriptions SET amount = $2, updated_at = now() WHERE server_id = $1 AND owner_id = $3 AND status IN ('active', 'past_due', 'suspended')", [s.id, to, customerId]);
  }
  return { changed, kept };
}
const discountOf = async (db: Db, resellerId: string) => Number((await db.query('SELECT discount_pct FROM resellers WHERE user_id = $1', [resellerId])).rows[0]?.discount_pct ?? 0);

// Who manages the signed-in account, for its account page: the reseller it belongs to (users.reseller_id), or null.
// A reseller can see the account's servers, order servers for it and manage them, and pays for them; it cannot sign in
// as the customer or read their tickets or settings (no route gives it that). `active` false: the reseller is switched
// off and cannot act now. The first time the customer uses the panel they are told so once, by a notification
// (account.reseller, step "managed"): the account was opened by somebody else, for an address nobody had proven.
// Not while staff act as them: the notice is for the person.
async function managedBy(req: AuthedRequest) {
  const { rows: [m] } = await pool.query(`SELECT r.id, r.name, r.email, coalesce(x.active, false) AS active, x.brand_name AS brand, u.reseller_notice_at AS told
    FROM users u JOIN users r ON r.id = u.reseller_id LEFT JOIN resellers x ON x.user_id = r.id WHERE u.id = $1`, [req.user.id]);
  if (!m) return null;
  if (!m.told && !req.user.impersonatedBy) {
    const { rowCount } = await pool.query('UPDATE users SET reseller_notice_at = now() WHERE id = $1 AND reseller_id = $2 AND reseller_notice_at IS NULL', [req.user.id, m.id]);
    if (rowCount) {
      await notify('account.reseller', [req.user.id], { step: 'managed', name: m.name ?? '', email: m.email });
      await audit(req, 'reseller.customer_told', 'success', req.user.id, { reseller: m.id });
    }
  }
  // afterLeave: what the servers the reseller pays for would cost the customer a month once the account leaves the
  // reseller (listPrices; an empty list: nothing changes), so the choice is not made blind.
  const { rows: paid } = await pool.query(`SELECT b.server_id FROM subscriptions b JOIN servers s ON s.id = b.server_id
    WHERE s.owner_id = $1 AND b.owner_id = $2 AND b.status IN ('active', 'past_due', 'suspended')`, [req.user.id, m.id]);
  const after = await listPrices(pool, req.user.id, paid.map((p) => p.server_id), await discountOf(pool, m.id), false).catch(() => ({ changed: [] as ListPrice[] }));
  return { name: m.name ?? '', email: m.email as string, brand: (m.brand ?? null) as string | null, active: !!m.active, canLeave: true, afterLeave: after.changed };
}

// Customers stop being the reseller's (one, or all of them with `only` null): the reseller can no longer act on their
// servers, and who pays follows (billing.ts, directBilling: the running subscriptions become the customer's, the
// reseller's unpaid renewals for them are withdrawn so the customer is invoiced from the first unpaid period). The key
// the reseller put on the account for the servers it ordered (order, below) is no longer offered to new servers or a
// reinstall; what is inside a running server stays there, and the customer is told. All in one transaction that holds
// the customers' rows; `end` runs in it too (removing the reseller). The reseller's discount comes off those servers'
// prices in the same transaction (listPrices), for what is invoiced from now on. Afterwards the reseller's open consoles are
// closed and both sides are told (the reseller not when it is being removed itself).
type Released = { id: string; email: string; servers: number; subscriptions: number; withdrawn: string[]; left: string[]; keys: number; prices: { changed: ListPrice[]; kept: string[] } };
async function releaseCustomers(resellerId: string, only: string | null, tellReseller: boolean, end?: (db: PoolClient) => Promise<unknown>): Promise<Released[]> {
  const client = await pool.connect();
  const out: Released[] = [], queue: string[] = [];
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, email FROM users WHERE reseller_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY id FOR UPDATE', [resellerId, only]);
    const pct = await discountOf(client, resellerId);
    for (const c of rows) {
      const b = await directBilling(client, c.id, resellerId);
      // The discount was the reseller's: the servers that are the customer's to pay now cost the list price from the
      // next invoice on (listPrices). The same for every way out: the customer leaving, staff, the reseller removed.
      const prices = await listPrices(client, c.id, b.servers, pct, true);
      const { rows: keys } = await client.query("DELETE FROM ssh_keys WHERE owner_id = $1 AND name = 'reseller' RETURNING public_key", [c.id]);
      if (keys.length) {
        await client.query(`UPDATE servers SET ssh_public_keys = ARRAY(SELECT k FROM unnest(ssh_public_keys) k WHERE k <> ALL($2::text[])), updated_at = now()
          WHERE owner_id = $1 AND state <> 'deleted' AND ssh_public_keys && $2::text[]`, [c.id, keys.map((k) => String(k.public_key))]);
      }
      await client.query('UPDATE users SET reseller_id = NULL WHERE id = $1', [c.id]);
      const { rows: [n] } = await client.query("SELECT count(*)::int AS n FROM servers WHERE owner_id = $1 AND state <> 'deleted'", [c.id]);
      queue.push(...b.enqueue);
      out.push({ id: c.id, email: c.email, servers: n.n, subscriptions: b.subscriptions.length, withdrawn: b.withdrawn, left: b.left, keys: keys.length, prices });
    }
    if (end) await end(client);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
  for (const id of queue) await enqueue(id);
  if (!out.length) return out;
  await revokeConsoles({ userId: resellerId });
  const { rows: [r] } = await pool.query('SELECT name, email FROM users WHERE id = $1', [resellerId]);
  for (const c of out) {
    // priced: how many servers lost the reseller's discount; monthly / was: what they cost a month from the next invoice, and did.
    await notify('account.reseller', [c.id], { step: 'left', name: r?.name ?? '', email: r?.email ?? '', servers: c.servers, keys: c.keys, priced: c.prices.changed.length,
      monthly: monthlyTotals(c.prices.changed.map((p) => ({ currency: p.currency, amount: p.to }))), was: monthlyTotals(c.prices.changed.map((p) => ({ currency: p.currency, amount: p.from }))) });
    if (tellReseller) await notify('account.reseller', [resellerId], { step: 'customer_left', email: c.email, servers: c.servers, left: c.left.length });
  }
  return out;
}
// What the audit event of a release says about one customer. forOwner: the event is also in that customer's own
// activity (audit-log.ts).
const releasedDetail = (c: Released, resellerId: string, by: 'staff' | 'customer') => ({ target: c.id, ...actingFor(c.id), reseller: resellerId, by, servers: c.servers, subscriptions: c.subscriptions,
  withdrawnInvoices: c.withdrawn, leftInvoices: c.left, removedKeys: c.keys, listPrices: c.prices.changed, pricesKept: c.prices.kept });

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
    // managedBy: for an account that is a reseller's customer, who that is (shown on the account page); null otherwise.
    if (!own) return { allocation: null, managedBy: await managedBy(req) };
    const r = row(own);
    const { rows: [c] } = await pool.query('SELECT count(*)::int AS n FROM users WHERE reseller_id = $1', [r.id]);
    return { allocation: r, usage: { ...(await resellerUsage(r.id)), customers: c.n }, managedBy: null };
  }

  // The customer takes the account out of the reseller's hands: the reseller can no longer see or manage their
  // servers, and the servers are billed to the customer from the first period nobody has paid (releaseCustomers).
  @Post('leave') @HttpCode(200)
  async leave(@Req() req: AuthedRequest) {
    // Who manages the account and who pays for its servers is the person's own decision: not staff acting as them
    // (staff take a customer out of a reseller's hands as themselves: admin/resellers/:id/customers/:customerId).
    if (req.user.impersonatedBy) throw apiError(403, 'NOT_WHILE_IMPERSONATING', 'Not while acting as another user');
    const { rows: [u] } = await pool.query('SELECT reseller_id FROM users WHERE id = $1', [req.user.id]);
    if (!u?.reseller_id) throw apiError(409, 'NOT_MANAGED', 'This account is not managed by a reseller');
    const [c] = await releaseCustomers(u.reseller_id, req.user.id, true);
    if (!c) throw apiError(409, 'NOT_MANAGED', 'This account is not managed by a reseller');
    await audit(req, 'reseller.customer_released', 'success', req.user.id, releasedDetail(c, u.reseller_id, 'customer'));
    return { ok: true, servers: c.servers, subscriptions: c.subscriptions, listPrices: c.prices.changed };
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
    // Not marked verified: the reseller typed the address, nobody proved it. Signing in with the password (set through
    // "forgot password") needs no verified address; the first sign-in by e-mail code or link proves it.
    await pool.query('UPDATE users SET reseller_id = $2 WHERE id = $1', [user.id, r.id]);
    await audit(req, 'reseller.customer_created', 'success', req.user.id, { target: user.id, ...actingFor(user.id, 'reseller') });
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
  @Post('customers/:id/servers') @HttpCode(202) @Can('servers.create')
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
      locale: u.locale === 'tr' ? 'tr' : 'en', timeZone: null, username: null, impersonatedBy: null, twoFactorEnabled: false, phoneNumber: null, phoneNumberVerified: false },
      // The build counts against the reseller's share of the worker's slots, not each customer's (servers.ts cappedFor).
      capFor: req.user.id });
    const out = await new ServersController().create(owner, `reseller-${randomUUID()}`, { ...body, sshKeyIds, billingCycle: 'monthly' });
    await audit(req, 'reseller.server_ordered', 'success', req.user.id, { target: id, serverId: out.serverId, ...actingFor(id, 'reseller') });
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
    if (!r) return { reseller: null };
    // customers: the accounts it manages, for staff to take one out of its hands (release, below).
    const { rows: customers } = await pool.query(`SELECT u.id, u.email, u.name, (SELECT count(*)::int FROM servers s WHERE s.owner_id = u.id AND s.state <> 'deleted') AS servers
      FROM users u WHERE u.reseller_id = $1 ORDER BY u.email LIMIT 500`, [id]);
    return { reseller: { ...row(r), active: r.active }, usage: await resellerUsage(id), customers };
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
    // Switched off (active false) the reseller can no longer act on its customers' servers, while everything else stays
    // as it is so that it can be switched on again: the customers stay its customers and their running subscriptions
    // stay billed to it. billedSubscriptions says how many; to end that, remove the reseller or take customers out.
    const active = body?.active !== false;
    const { rows: [b] } = await pool.query(`SELECT count(*)::int AS n FROM subscriptions b JOIN servers s ON s.id = b.server_id JOIN users o ON o.id = s.owner_id
      WHERE b.owner_id = $1 AND o.reseller_id = $1 AND b.status IN ('active', 'past_due', 'suspended')`, [id]);
    await audit(req, 'reseller.saved', 'success', req.user.id, { target: id, ...v, discount, active, billedSubscriptions: b.n });
    return { ok: true, active, billedSubscriptions: b.n };
  }

  // No longer a reseller; their customers become ordinary accounts (their servers stay theirs) and pay for their
  // servers themselves from the first period nobody has paid (releaseCustomers): the reseller, who can no longer act on
  // those servers, is not left paying for them, nor able to end them by cancelling a subscription.
  @Delete(':id') @HttpCode(204) @Can('users.manage')
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const released = await releaseCustomers(id, null, false, (db) => db.query('DELETE FROM resellers WHERE user_id = $1', [id]));
    for (const c of released) await audit(req, 'reseller.customer_released', 'success', req.user.id, releasedDetail(c, id, 'staff'));
    await audit(req, 'reseller.removed', 'success', req.user.id, { target: id, customers: released.length, subscriptions: released.reduce((n, c) => n + c.subscriptions, 0),
      leftInvoices: released.flatMap((c) => c.left) });
  }

  // Staff take one customer out of a reseller's hands (the same as the customer leaving, reseller/leave).
  @Delete(':id/customers/:customerId') @HttpCode(200) @Can('users.manage')
  async release(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('customerId', ParseUUIDPipe) customerId: string) {
    const [c] = await releaseCustomers(id, customerId, true);
    if (!c) throw apiError(404, 'NOT_FOUND', 'Not a customer of this reseller');
    await audit(req, 'reseller.customer_released', 'success', req.user.id, releasedDetail(c, id, 'staff'));
    return { ok: true, servers: c.servers, subscriptions: c.subscriptions, withdrawnInvoices: c.withdrawn, leftInvoices: c.left, listPrices: c.prices.changed, pricesKept: c.prices.kept };
  }
}
