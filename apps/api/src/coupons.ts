// Coupons (migration 054): a code the customer enters when ordering a monthly server. Percent or a fixed amount off, for
// the first N invoices (or all of them), limited in uses, by date, to packages or to new customers. Staff manage them
// under Admin → Billing → Coupons. A deactivated coupon takes no new orders; the subscriptions that have it keep it.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { audit, type AuthedRequest } from './auth';
import { couponPrice, fromCents, toCents } from './billing-rules';
import { pool } from './db';
import { apiError } from './errors';
import { Can, PermissionGuard } from './rbac';

type Db = typeof pool | PoolClient;
export type CouponUse = { id: string; code: string; monthly: string; periods: number | null; once: boolean };

const columns = `c.id, c.code, c.kind, c.value::text AS value, trim(c.currency) AS currency, c.periods, c.max_uses AS "maxUses", c.once_per_user AS "oncePerUser",
  c.new_customers AS "newCustomers", c.package_ids AS "packageIds", c.expires_at AS "expiresAt", c.active, c.note, c.created_at AS "createdAt",
  (SELECT count(*)::int FROM coupon_redemptions r WHERE r.coupon_id = c.id) AS uses`;
const refuse = (code: string) => apiError(400, 'VALIDATION_FAILED', 'This coupon cannot be used', { coupon: code });

// The discounted first price of an order, or why the code does not apply. `lock`: inside the order's transaction, so two
// orders can never take a coupon's last use (the row is locked until the order commits).
export async function checkCoupon(db: Db, raw: string, userId: string, order: { packageId: string | null; monthly: string; currency: string }, lock = false): Promise<CouponUse> {
  const code = raw.trim().toUpperCase();
  const { rows: [c] } = await db.query(`SELECT ${columns}, c.expires_at < now() AS expired FROM coupons c WHERE c.code = $1${lock ? ' FOR UPDATE' : ''}`, [code]);
  if (!c || !c.active) throw refuse('COUPON_UNKNOWN');
  if (c.expired) throw refuse('COUPON_EXPIRED');
  if (c.maxUses !== null && c.uses >= c.maxUses) throw refuse('COUPON_USED_UP');
  if (c.packageIds && !(order.packageId && c.packageIds.includes(order.packageId))) throw refuse('COUPON_NOT_FOR_PACKAGE');
  if (c.kind === 'fixed' && c.currency !== order.currency.trim()) throw refuse('COUPON_CURRENCY');
  if (c.oncePerUser && (await db.query('SELECT 1 FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2', [c.id, userId])).rowCount) throw refuse('COUPON_ALREADY_USED');
  if (c.newCustomers && (await db.query('SELECT 1 FROM servers WHERE owner_id = $1 LIMIT 1', [userId])).rowCount) throw refuse('COUPON_NEW_CUSTOMERS');
  return { id: c.id, code: c.code, monthly: fromCents(couponPrice(toCents(order.monthly), c.kind, toCents(c.value))), periods: c.periods, once: c.oncePerUser };
}

// The coupon's price for one renewal, when the subscription still has discounted invoices left.
export async function renewalPrice(db: Db, sub: { coupon_id: string | null; coupon_left: number | null; currency: string }, monthly: string) {
  if (!sub.coupon_id || (sub.coupon_left !== null && sub.coupon_left <= 0)) return null;
  const { rows: [c] } = await db.query('SELECT code, kind, value::text AS value, trim(currency) AS currency FROM coupons WHERE id = $1', [sub.coupon_id]);
  if (!c || (c.kind === 'fixed' && c.currency !== sub.currency.trim())) return null;
  return { code: c.code as string, monthly: fromCents(couponPrice(toCents(monthly), c.kind, toCents(c.value))) };
}

function clean(body: Record<string, unknown>, partial: boolean) {
  const fields: Record<string, string> = {};
  const v: Record<string, unknown> = {};
  const has = (k: string) => body?.[k] !== undefined;
  if (!partial || has('code')) {
    v.code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (!/^[A-Z0-9_-]{3,32}$/.test(v.code as string)) fields.code = 'INVALID_COUPON_CODE';
  }
  if (!partial || has('kind') || has('value')) {
    v.kind = body.kind === 'fixed' ? 'fixed' : 'percent';
    const n = Number(body.value);
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(String(body.value ?? '')) || n <= 0 || (v.kind === 'percent' && n > 100)) fields.value = 'OUT_OF_RANGE';
    v.value = String(body.value);
    v.currency = v.kind === 'fixed' ? (typeof body.currency === 'string' && /^[A-Z]{3}$/.test(body.currency) ? body.currency : (fields.currency = 'INVALID_CURRENCY', null)) : null;
  }
  const optInt = (k: string, min: number, max: number) => {
    if (!has(k)) return;
    const raw = body[k];
    if (raw === null || raw === '') { v[k] = null; return; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) fields[k] = 'OUT_OF_RANGE'; else v[k] = n;
  };
  optInt('periods', 1, 120); optInt('maxUses', 1, 1_000_000);
  for (const k of ['oncePerUser', 'newCustomers', 'active']) if (has(k)) v[k] = body[k] === true;
  if (has('packageIds')) {
    const ids = Array.isArray(body.packageIds) ? body.packageIds.map(String) : [];
    if (ids.some((x) => !/^[0-9a-f-]{36}$/i.test(x))) fields.packageIds = 'INVALID_VALUE';
    v.packageIds = ids.length ? ids : null;
  }
  if (has('expiresAt')) {
    v.expiresAt = body.expiresAt === null || body.expiresAt === '' ? null : String(body.expiresAt);
    if (v.expiresAt && Number.isNaN(Date.parse(v.expiresAt as string))) fields.expiresAt = 'INVALID_VALUE';
  }
  if (has('note')) v.note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) || null : null;
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return v;
}
const dbColumn: Record<string, string> = { code: 'code', kind: 'kind', value: 'value', currency: 'currency', periods: 'periods', maxUses: 'max_uses', oncePerUser: 'once_per_user',
  newCustomers: 'new_customers', packageIds: 'package_ids', expiresAt: 'expires_at', active: 'active', note: 'note' };

@Controller('admin/coupons') @UseGuards(PermissionGuard)
export class CouponsAdminController {
  // Every coupon with its uses and the money it has taken off so far (the invoices of its subscriptions, first ones included).
  @Get() @Can('billing.view')
  async list() {
    const { rows } = await pool.query(`SELECT ${columns}, (SELECT count(*)::int FROM subscriptions b WHERE b.coupon_id = c.id AND b.status IN ('active', 'past_due', 'suspended')) AS "activeSubscriptions"
      FROM coupons c ORDER BY c.active DESC, c.created_at DESC`);
    return { coupons: rows };
  }

  @Post() @HttpCode(201) @Can('billing.manage')
  async create(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const v = clean(body ?? {}, false);
    const keys = Object.keys(v);
    try {
      const { rows: [c] } = await pool.query(`INSERT INTO coupons (${keys.map((k) => dbColumn[k]).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, keys.map((k) => v[k]));
      await audit(req, 'billing.coupon_created', 'success', req.user.id, { couponId: c.id, code: v.code });
      return { id: c.id };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw apiError(409, 'VALIDATION_FAILED', 'Code taken', { code: 'COUPON_CODE_TAKEN' });
      throw e;
    }
  }

  // Changes what new orders get. The amount and the code stay once someone has used it (their invoices name them).
  @Put(':id') @Can('billing.manage')
  async update(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const v = clean(body ?? {}, true);
    const { rows: [c] } = await pool.query('SELECT (SELECT count(*)::int FROM coupon_redemptions r WHERE r.coupon_id = $1) AS uses FROM coupons WHERE id = $1', [id]);
    if (!c) throw apiError(404, 'NOT_FOUND', 'Unknown coupon');
    if (c.uses > 0 && ['code', 'kind', 'value', 'currency'].some((k) => k in v)) throw apiError(409, 'COUPON_IN_USE', 'A used coupon keeps its code and amount');
    const keys = Object.keys(v);
    if (keys.length) await pool.query(`UPDATE coupons SET ${keys.map((k, i) => `${dbColumn[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => v[k])]);
    await audit(req, 'billing.coupon_updated', 'success', req.user.id, { couponId: id, ...v });
    return { ok: true };
  }

  // Only a coupon nobody used goes away; a used one is deactivated instead (its subscriptions keep their discount).
  @Delete(':id') @HttpCode(204) @Can('billing.manage')
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await pool.query('DELETE FROM coupons c WHERE c.id = $1 AND NOT EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.coupon_id = c.id)', [id]);
    if (!rowCount) throw apiError(409, 'COUPON_IN_USE', 'A used coupon can only be deactivated');
    await audit(req, 'billing.coupon_deleted', 'success', req.user.id, { couponId: id });
  }
}
