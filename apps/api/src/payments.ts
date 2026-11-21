// Settings → Payments: every provider of payment-providers.ts can be configured with separate live and test
// credentials (both kept), checked against the provider without moving money, and activated in one mode.
// Activation needs a check made on exactly the saved credentials of that mode; changing them while active
// deactivates the provider until it is checked again. Secrets never leave the server.
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { pool } from './db';
import { apiError } from './errors';
import { audit, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { decryptSecret, encryptSecret } from './secrets';
import { logEvent } from './log';
import { checkCredentials, providers, type CheckResult, type Mode } from './payment-providers';

type Input = Record<string, unknown>;
type Creds = Record<string, string>;
type Check = CheckResult & { at: string; version: number };
type Row = { id: string; enabled: boolean; mode: Mode; label: string; live_enc: string | null; test_enc: string | null; live_version: number; test_version: number;
  live_check: Check | null; test_check: Check | null; sort: number; updated_at: string };
const modes: Mode[] = ['live', 'test'];
// Verified enough to take payments: the check passed, or the provider gives nothing to check against (shown as such).
const usable = new Set(['ok', 'unverifiable', 'inconclusive']);

const context = (id: string, mode: Mode) => `payments:${id}:${mode}`;
const decrypt = (row: Row | undefined, mode: Mode): Creds => {
  const enc = row?.[`${mode}_enc`];
  return enc ? JSON.parse(decryptSecret(enc, context(row!.id, mode))) : {};
};

function provider(id: string) {
  const p = providers[id];
  if (!p) throw apiError(404, 'NOT_FOUND', 'Unknown payment provider');
  return p;
}

// Where a mode's credentials are sent: the endpoint when one is given, else the provider's own host.
const destination = (endpoint: unknown, fallback: string) => ((typeof endpoint === 'string' && endpoint.trim()) || fallback).replace(/\/+$/, '').toLowerCase();

// Validates one mode's form: empty secrets keep the stored value; the optional endpoint overrides the host.
function readCreds(id: string, input: unknown, saved: Creds, mode: Mode, fields: Record<string, string>): Creds {
  const p = provider(id);
  const values = (input ?? {}) as Input;
  const out: Creds = {};
  // Stored secrets are for the address they were entered for: with another endpoint in the form they are typed again
  // (otherwise a save, or a test, would send them to whatever host the form names). The same rule as settings.ts.
  const moved = !!values.endpoint && destination(values.endpoint, p.hosts[mode]) !== destination(saved.endpoint, p.hosts[mode]);
  for (const f of p.fields) {
    const v = typeof values[f.key] === 'string' ? (values[f.key] as string).trim() : '';
    out[f.key] = v || (f.secret && !moved ? saved[f.key] ?? '' : '');
    if (f.secret && moved && !v && saved[f.key]) fields[`${mode}.${f.key}`] = 'REQUIRED';
    if (!out[f.key] && !f.optional) fields[`${mode}.${f.key}`] = 'REQUIRED';
    if (out[f.key].length > 2000) fields[`${mode}.${f.key}`] = 'INVALID_VALUE';
    if (f.options && out[f.key] && !f.options.includes(out[f.key])) fields[`${mode}.${f.key}`] = 'INVALID_VALUE';
    if (!out[f.key]) delete out[f.key];
  }
  const endpoint = typeof values.endpoint === 'string' ? values.endpoint.trim() : '';
  if (endpoint) {
    // A public https host only: the API must not be pointed at the platform's own internal services.
    const host = /^https:\/\/([a-z0-9.-]+)(:\d{1,5})?(\/[\w./%-]*)?$/i.exec(endpoint)?.[1]?.toLowerCase();
    if (!host || !host.includes('.') || /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(host)) fields[`${mode}.endpoint`] = 'INVALID_ENDPOINT';
    else out.endpoint = endpoint;
  }
  return out;
}
// What the caller of a test is told: the outcome and the class of the HTTP answer, in fixed words. The remote text stays
// in the server's log: with an endpoint in the form, the answer is that of whatever host staff named.
const said: Record<CheckResult['status'], string> = { ok: 'The provider accepted the credentials', rejected: 'The provider rejected the credentials',
  inconclusive: 'The provider answered, but not in a way that confirms the credentials', network: 'The provider could not be reached',
  unverifiable: 'This provider offers nothing to check the credentials against' };
const brief = (r: CheckResult): CheckResult => ({ status: r.status, message: `${said[r.status]}${r.httpStatus ? ` (HTTP ${Math.floor(r.httpStatus / 100)}xx)` : ''}`, unverified: r.unverified });
const same = (a: Creds, b: Creds) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

// A provider that goes live takes no more test money: test payments still open are closed (their test card would
// otherwise pay a real invoice later; billing.ts refuses them too).
const closeTestPayments = (id: string) => pool.query(`UPDATE payments SET status = 'failed', error_code = 'TEST_MODE_OFF', error_message = 'The provider was switched to live', completed_at = now()
  WHERE provider = $1 AND mode = 'test' AND status = 'pending'`, [id]);

async function rowOf(id: string) {
  return (await pool.query<Row>('SELECT * FROM payment_gateways WHERE id = $1', [id])).rows[0];
}

function view(row: Row) {
  const p = providers[row.id];
  const side = (mode: Mode) => {
    const c = decrypt(row, mode);
    const check = row[`${mode}_check`];
    return {
      values: Object.fromEntries([...p.fields.filter((f) => !f.secret).map((f) => [f.key, c[f.key] ?? '']), ['endpoint', c.endpoint ?? '']]),
      secretsSet: Object.fromEntries(p.fields.filter((f) => f.secret).map((f) => [f.key, !!c[f.key]])),
      complete: p.fields.every((f) => f.optional || !!c[f.key]),
      configured: Object.keys(c).length > 0,
      check: check ? { ...check, current: check.version === row[`${mode}_version`] } : null,
    };
  };
  return { id: row.id, enabled: row.enabled, mode: row.mode, label: row.label, sort: row.sort, live: side('live'), test: side('test'), updatedAt: row.updated_at };
}

// Why a provider cannot be active in this mode (or null).
function blocker(row: Row, mode: Mode) {
  const p = providers[row.id];
  const c = decrypt(row, mode);
  if (!p.fields.every((f) => f.optional || !!c[f.key])) return 'PAYMENT_INCOMPLETE';
  const check = row[`${mode}_check`];
  if (!check || check.version !== row[`${mode}_version`]) return 'PAYMENT_NOT_TESTED';
  if (!usable.has(check.status)) return 'PAYMENT_TEST_FAILED';
  return null;
}

@Controller('admin/settings/payments') @UseGuards(PermissionGuard)
export class PaymentsController {
  @Get() @Can('settings.view', 'settings.manage')
  async list() {
    const { rows } = await pool.query<Row>('SELECT * FROM payment_gateways ORDER BY sort, id');
    return {
      providers: Object.entries(providers).map(([id, p]) => ({ id, name: p.name, kind: p.kind, platform: p.platform, website: p.website, docs: p.docs, confidence: p.confidence,
        fields: p.fields, hosts: p.hosts, threeD: p.threeD, notes: p.notes, checkable: !!p.check, testCredentials: p.testCredentials ?? null, testCards: p.testCards ?? [], webhook: p.webhook ?? null })),
      gateways: rows.filter((r) => providers[r.id]).map(view),
    };
  }

  // Saves either or both modes. A mode left out of the body is not touched; `clear` removes a mode's credentials.
  @Put(':id') @Can('settings.manage')
  async save(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: Input) {
    provider(id);
    const row = await rowOf(id);
    const fields: Record<string, string> = {};
    const clear = Array.isArray(body?.clear) ? body.clear.filter((m): m is Mode => modes.includes(m as Mode)) : [];
    const next: Partial<Record<Mode, Creds | null>> = {};
    for (const mode of modes) {
      if (clear.includes(mode)) { next[mode] = null; continue; }
      if (body?.[mode] !== undefined) next[mode] = readCreds(id, body[mode], decrypt(row, mode), mode, fields);
    }
    const mode: Mode = body?.mode === 'live' || body?.mode === 'test' ? body.mode : row?.mode ?? 'test';
    const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 60) : row?.label ?? '';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);

    const changed = modes.filter((m) => next[m] !== undefined && !same(next[m] ?? {}, decrypt(row, m)));
    const enc = (m: Mode) => (next[m] === undefined ? row?.[`${m}_enc`] ?? null : next[m] && Object.keys(next[m]!).length ? encryptSecret(JSON.stringify(next[m]), context(id, m)) : null);
    const version = (m: Mode) => (row?.[`${m}_version`] ?? 0) + (changed.includes(m) ? 1 : 0);
    // Changing the credentials (or the mode) of an active provider deactivates it until checked again.
    let enabled = row?.enabled ?? false;
    if (enabled && (changed.includes(mode) || mode !== row?.mode)) enabled = false;
    await pool.query(`INSERT INTO payment_gateways (id, enabled, mode, label, live_enc, test_enc, live_version, test_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET enabled = $2, mode = $3, label = $4, live_enc = $5, test_enc = $6, live_version = $7, test_version = $8, updated_at = now()`,
      [id, enabled, mode, label, enc('live'), enc('test'), version('live'), version('test')]);
    if (mode === 'live') await closeTestPayments(id);
    await audit(req, 'settings.payment_saved', 'success', req.user.id, { provider: id, mode, changed, deactivated: !!row?.enabled && !enabled });
    return view((await rowOf(id))!);
  }

  // Checks the credentials in the form (merged with stored secrets) against the provider. The result counts
  // for activation only when they are exactly the saved credentials of that mode.
  @Post(':id/test') @HttpCode(200) @Can('settings.manage')
  async test(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: Input) {
    provider(id);
    const mode: Mode = body?.mode === 'live' ? 'live' : 'test';
    const row = await rowOf(id);
    const saved = decrypt(row, mode);
    const fields: Record<string, string> = {};
    const creds = readCreds(id, body?.credentials ?? saved, saved, mode, fields);
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    const full = await checkCredentials(id, creds, mode);
    if (full.message) logEvent('info', 'payment_test', { provider: id, mode, status: full.status, httpStatus: full.httpStatus, detail: full.message.slice(0, 200) });
    const result = brief(full);
    const recorded = !!row && same(creds, saved);
    if (recorded) {
      await pool.query(`UPDATE payment_gateways SET ${mode}_check = $2, updated_at = now() WHERE id = $1`,
        [id, { ...result, at: new Date().toISOString(), version: row[`${mode}_version`] }]);
    }
    await audit(req, 'settings.payment_test', result.status === 'ok' ? 'success' : 'failure', req.user.id, { provider: id, mode, status: result.status });
    return { ...result, mode, recorded };
  }

  // Turns a provider on (in the given mode) or off.
  @Post(':id/state') @HttpCode(200) @Can('settings.manage')
  async state(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: Input) {
    provider(id);
    const row = await rowOf(id);
    if (!row) throw apiError(409, 'PAYMENT_INCOMPLETE', 'Save the credentials first');
    const mode: Mode = body?.mode === 'live' || body?.mode === 'test' ? body.mode : row.mode;
    const enabled = body?.enabled === true;
    if (enabled) {
      const reason = blocker(row, mode);
      if (reason) throw apiError(409, reason, 'This provider cannot be activated yet');
    }
    await pool.query('UPDATE payment_gateways SET enabled = $2, mode = $3, updated_at = now() WHERE id = $1', [id, enabled, mode]);
    if (mode === 'live') await closeTestPayments(id);
    await audit(req, enabled ? 'settings.payment_enabled' : 'settings.payment_disabled', 'success', req.user.id, { provider: id, mode });
    return view((await rowOf(id))!);
  }

  // Order shown to customers at checkout.
  @Put() @Can('settings.manage')
  async order(@Req() req: AuthedRequest, @Body() body: Input) {
    const ids = Array.isArray(body?.order) ? body.order.map(String).filter((x) => providers[x]) : [];
    for (const [i, id] of ids.entries()) await pool.query('UPDATE payment_gateways SET sort = $2 WHERE id = $1', [id, i]);
    await audit(req, 'settings.payment_order', 'success', req.user.id, { order: ids });
    return this.list();
  }

  @Delete(':id') @HttpCode(204) @Can('settings.manage')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    provider(id);
    await pool.query('DELETE FROM payment_gateways WHERE id = $1', [id]);
    await audit(req, 'settings.payment_removed', 'success', req.user.id, { provider: id });
  }
}

// What checkout will use: active providers in the admin's order, with the credentials of their mode.
// The credentials billing charges with: the active mode of an enabled, checked provider; or, for a payment made earlier
// in a given mode (its callback or refund), that mode's credentials even if the provider was switched since.
export async function activeGateway(id: string, mode?: Mode) {
  const row = await rowOf(id);
  if (!row || !providers[id]) return null;
  if (!mode && (!row.enabled || blocker(row, row.mode))) return null;
  const m = mode ?? row.mode;
  const creds = decrypt(row, m);
  if (!Object.keys(creds).length) return null;
  return { mode: m, creds: { ...creds, endpoint: creds.endpoint || providers[id].hosts[m] } };
}

// A payment begun in test mode while the provider now takes real money: its test card must not pay anything any more.
export async function testModeOver(id: string, mode: Mode) {
  return mode === 'test' && (await rowOf(id))?.mode === 'live';
}

export async function activePaymentMethods() {
  const { rows } = await pool.query<Row>('SELECT * FROM payment_gateways WHERE enabled ORDER BY sort, id');
  return rows.filter((r) => providers[r.id] && !blocker(r, r.mode)).map((r) => ({ id: r.id, name: r.label || providers[r.id].name, mode: r.mode, kind: providers[r.id].kind }));
}
