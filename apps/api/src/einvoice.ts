// e-Fatura / e-Arşiv: a paid invoice goes to the chosen GİB integrator (einvoice-providers.ts) as UBL-TR (ubl.ts).
// The buyer's tax number decides: an e-Fatura user gets an e-Fatura to its inbox alias (checked again at issue time),
// everyone else (people, unregistered companies, customers abroad) an e-Arşiv invoice delivered by e-mail, as an internet
// sale. Numbers run per year in two series (e-Fatura, e-Arşiv). Sending retries with backoff; status is polled until GİB
// accepts or refuses. A refund within 8 days of delivery cancels an e-Arşiv invoice; later (and for e-Fatura) a return
// invoice is needed, which staff are told about. With no integrator ('none') invoices are issued in the panel only.
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { pool, redis } from './db';
import { apiError } from './errors';
import { logEvent } from './log';
import { notify } from './notify';
import { Can, PermissionGuard } from './rbac';
import { decryptSecret, encryptSecret } from './secrets';
import { getSettings, saveSettings, type EinvoiceSettings } from './settings-store';
import { invoiceNumber, validPrefix } from './billing-rules';
import { buildUbl, inWords } from './ubl';
import { EinvoiceError, integrators, tag, type Creds, type Kind } from './einvoice-providers';

const settings = () => getSettings('einvoice');
const ctx = 'settings:einvoice';
const day = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul' }).format(d);
const time = (d = new Date()) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);

function credsOf(s: EinvoiceSettings): Creds | null {
  const p = integrators[s.provider];
  if (!p) return null;
  const secret = s.credentialsEnc ? JSON.parse(decryptSecret(s.credentialsEnc, ctx)) as Record<string, string> : {};
  return { ...s.values, ...secret, endpoint: s.values.endpoint || p.hosts[s.mode] };
}

// The Central Bank's selling rate for a foreign-currency invoice (UBL needs it); cached for the day.
async function exchangeRate(currency: string) {
  if (currency === 'TRY') return undefined;
  const key = `tcmb:${day()}:${currency}`;
  const hit = await redis.get(key).catch(() => null);
  if (hit) return hit;
  const xml = await (await fetch('https://www.tcmb.gov.tr/kurlar/today.xml', { signal: AbortSignal.timeout(15_000) })).text();
  const block = new RegExp(`<Currency[^>]*CurrencyCode="${currency}"[^>]*>([\\s\\S]*?)</Currency>`).exec(xml)?.[1] ?? '';
  const rate = tag(block, 'ForexSelling');
  if (!rate) throw new EinvoiceError(`no TCMB rate for ${currency}`);
  await redis.set(key, rate, 'EX', 86_400).catch(() => undefined);
  return rate;
}

// Whether a buyer is an e-Fatura user (asked at the integrator), kept on the billing profile.
export async function lookupProfile(userId: string) {
  const s = await settings();
  const c = credsOf(s);
  if (!c) return null;
  const { rows: [p] } = await pool.query('SELECT tax_id, country FROM billing_profiles WHERE user_id = $1', [userId]);
  if (!p || p.country !== 'TR' || p.tax_id === '11111111111') return null;
  const r = await integrators[s.provider].lookup(p.tax_id, c);
  await pool.query('UPDATE billing_profiles SET einvoice_registered = $2, einvoice_alias = $3, einvoice_checked_at = now() WHERE user_id = $1', [userId, r.registered, r.alias]);
  return r;
}

// One paid invoice to the integrator. Its ETTN is kept before the call, so a retry sends the same document.
async function sendOne(id: string, s: EinvoiceSettings, c: Creds) {
  const p = integrators[s.provider];
  const { rows: [inv] } = await pool.query("SELECT * FROM invoices WHERE id = $1 AND einvoice_status IN ('queued', 'failed')", [id]);
  if (!inv) return;
  const b = inv.buyer, seller = inv.seller;
  // e-Fatura only to a Turkish tax number registered for it, asked again now (users join the list every day).
  let kind: Kind = 'earsiv', alias: string | null = null;
  if (b.country === 'TR' && b.taxId !== '11111111111') {
    const r = await p.lookup(b.taxId, c);
    if (r.registered && r.alias) { kind = 'efatura'; alias = r.alias; }
  }
  const uuid = inv.einvoice_uuid ?? randomUUID();
  let number = inv.number as string | null;
  if (!number) {
    const prefix = kind === 'efatura' ? s.efaturaSeries : s.earsivSeries;
    const year = Number(day().slice(0, 4));
    const { rows: [q] } = await pool.query(`INSERT INTO invoice_sequences (prefix, year, last) VALUES ($1, $2, 1) ON CONFLICT (prefix, year) DO UPDATE SET last = invoice_sequences.last + 1 RETURNING last`, [prefix, year]);
    number = invoiceNumber(prefix, year, q.last);
  }
  const profile = kind === 'earsiv' ? 'EARSIVFATURA' : s.profile;
  await pool.query("UPDATE invoices SET einvoice_uuid = $2, number = $3, einvoice_profile = $4, einvoice_provider = $5, issued_at = coalesce(issued_at, now()) WHERE id = $1",
    [id, uuid, number, profile, s.provider]);
  const { rows: lines } = await pool.query('SELECT description, quantity::text, unit, unit_price::text AS "unitPrice", tax_rate::text AS "taxRate", net::text, tax::text FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort', [id]);
  const { rows: [pay] } = await pool.query("SELECT provider, method, completed_at FROM payments WHERE invoice_id = $1 AND status IN ('succeeded', 'partially_refunded', 'refunded') ORDER BY completed_at DESC LIMIT 1", [id]);
  const paidOn = day(pay?.completed_at ?? inv.paid_at ?? new Date());
  const intermediary = pay && !['balance', 'manual'].includes(pay.provider) ? pay.provider : (pay?.provider === 'balance' ? 'Bakiye' : 'Havale/EFT');
  const exemption = inv.tax_exemption ? { code: inv.tax_exemption, reason: '3065 sayılı KDV Kanunu 11/1-a maddesi gereğince hizmet ihracatı KDV’den istisnadır' } : null;
  const ubl = buildUbl({ uuid, number, issueDate: day(), issueTime: time(), profile, type: exemption ? 'ISTISNA' : 'SATIS', currency: inv.currency, exchangeRate: await exchangeRate(inv.currency),
    notes: [...(kind === 'earsiv' ? ['Bu satış internet üzerinden yapılmıştır.'] : []), inWords(inv.total, inv.currency), ...(inv.note ? [inv.note] : [])],
    supplier: { name: seller.name, taxId: seller.taxId, taxOffice: seller.taxOffice, address: seller.address, district: seller.district, city: seller.city, postalCode: seller.postalCode,
      country: seller.country || 'TR', email: seller.email, phone: seller.phone, website: seller.website, mersis: seller.mersis, tradeRegistry: seller.tradeRegistry },
    customer: { name: b.name, taxId: b.country === 'TR' ? b.taxId : '2222222222', taxOffice: b.taxOffice, address: b.address, district: b.district, city: b.city, postalCode: b.postalCode, country: b.country, email: b.email, phone: b.phone },
    lines, subtotal: inv.subtotal, taxTotal: inv.tax_total, total: inv.total, exemption,
    paymentMeans: { code: pay?.method === 'bank_transfer' ? '42' : pay?.method?.includes('card') ? '48' : 'ZZZ', date: paidOn, note: intermediary },
    ...(kind === 'earsiv' && { selfDelivered: true, sendingType: 'ELEKTRONIK' as const }) });
  try {
    const r = await p.send({ ubl, kind, uuid, number, alias, total: inv.total, currency: inv.currency, issueDate: day(), email: b.email ?? '', buyer: { taxId: b.taxId, name: b.name },
      sender: { taxId: seller.taxId, alias: s.senderAlias }, internet: { website: seller.website || '', method: pay?.method ?? 'other', intermediary, date: paidOn } }, c);
    await pool.query("UPDATE invoices SET einvoice_status = 'sent', einvoice_ref = $2, number = coalesce($3, number), einvoice_error = NULL, einvoice_at = now() WHERE id = $1", [id, r.ref, r.number ?? null]);
    logEvent('info', 'einvoice_sent', { invoiceId: id, kind, provider: s.provider });
  } catch (e) {
    const err = e instanceof EinvoiceError ? e : new EinvoiceError(String((e as Error)?.message ?? e));
    const { rows: [x] } = await pool.query("UPDATE invoices SET einvoice_status = 'failed', einvoice_error = $2, einvoice_attempts = einvoice_attempts + 1, einvoice_at = now() WHERE id = $1 RETURNING einvoice_attempts, number",
      [id, err.message]);
    logEvent('warn', 'einvoice_failed', { invoiceId: id, provider: s.provider, error: err.message });
    if (x.einvoice_attempts === 1 || x.einvoice_attempts === 5) await notify('billing.einvoice_failed', 'staff:billing.view', { invoiceId: id, number: x.number ?? '', error: err.message.slice(0, 200) });
  }
}

// Every queued invoice, and failed ones again with growing gaps (5, 20, 80 minutes...; at most 8 tries).
export async function sendQueued() {
  const s = await settings();
  const c = credsOf(s);
  if (!c) return 0;
  const { rows } = await pool.query(`SELECT id FROM invoices WHERE (einvoice_status = 'queued' OR (einvoice_status = 'failed' AND einvoice_attempts < 8 AND einvoice_at < now() - make_interval(mins => 5 * power(4, einvoice_attempts - 1)::int)))
    ORDER BY paid_at LIMIT 50`);
  for (const r of rows) {
    if (!(await redis.set(`einvoice:${r.id}`, '1', 'EX', 120, 'NX').catch(() => null))) continue; // one sender per invoice
    await sendOne(r.id, s, c).catch((e) => logEvent('error', 'einvoice_send_crashed', { invoiceId: r.id, error: String(e?.message ?? e).slice(0, 200) }));
    await redis.del(`einvoice:${r.id}`).catch(() => undefined);
  }
  return rows.length;
}

// Sent documents until GİB accepts or refuses them.
export async function pollStatus() {
  const s = await settings();
  const c = credsOf(s);
  if (!c) return 0;
  const { rows } = await pool.query("SELECT id, einvoice_uuid, einvoice_ref, einvoice_profile, einvoice_provider FROM invoices WHERE einvoice_status = 'sent' AND einvoice_provider = $1 AND einvoice_at > now() - interval '30 days' LIMIT 100", [s.provider]);
  for (const r of rows) {
    const kind: Kind = r.einvoice_profile === 'EARSIVFATURA' ? 'earsiv' : 'efatura';
    const st = await integrators[s.provider].status(s.provider === 'parasut' ? r.einvoice_ref : r.einvoice_uuid, kind, c).catch(() => null);
    if (!st || st.status === 'sent') continue;
    await pool.query("UPDATE invoices SET einvoice_status = $2, einvoice_error = $3 WHERE id = $1", [r.id, st.status === 'failed' ? 'rejected' : 'accepted', st.status === 'failed' ? st.detail ?? 'rejected' : null]);
  }
  return rows.length;
}

// A refund of a sent invoice: an e-Arşiv one is cancelled at the integrator within 8 days of delivery when fully refunded;
// otherwise a return invoice (iade faturası) is due, which staff are told to issue (for an e-Fatura buyer, the buyer issues it).
export async function creditNote(invoiceId: string, amount: string, reason: string) {
  const s = await settings();
  const c = credsOf(s);
  const { rows: [inv] } = await pool.query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
  if (!c || !inv?.einvoice_uuid || !['sent', 'accepted'].includes(inv.einvoice_status)) return null;
  const full = Number(inv.refunded_total) >= Number(inv.total);
  const withinWindow = inv.einvoice_at && Date.now() - new Date(inv.einvoice_at).getTime() < 8 * 86_400_000;
  if (inv.einvoice_profile === 'EARSIVFATURA' && full && withinWindow) {
    try {
      await integrators[s.provider].cancel(s.provider === 'parasut' ? inv.einvoice_ref : inv.einvoice_uuid, { number: inv.number, total: inv.total, date: day() }, c);
      await pool.query("UPDATE invoices SET einvoice_status = 'cancelled', einvoice_error = NULL WHERE id = $1", [invoiceId]);
      return 'cancelled';
    } catch (e) { await pool.query('UPDATE invoices SET einvoice_error = $2 WHERE id = $1', [invoiceId, `İptal edilemedi: ${String((e as Error)?.message ?? e).slice(0, 300)}`]); }
  }
  await notify('billing.einvoice_return', 'staff:billing.view', { invoiceId, number: inv.number ?? '', amount, currency: inv.currency, reason,
    who: inv.einvoice_profile === 'EARSIVFATURA' ? 'seller' : 'buyer' });
  return 'return_needed';
}

export function startEinvoice() {
  const tick = async () => {
    if (!(await redis.set('lock:einvoice', '1', 'EX', 100, 'NX').catch(() => null))) return;
    await sendQueued().catch((e) => logEvent('error', 'einvoice_run_failed', { error: String(e?.message ?? e).slice(0, 200) }));
    await pollStatus().catch(() => undefined);
  };
  return setInterval(tick, 2 * 60_000).unref();
}

// ---- Settings → e-Invoice ----
function view(s: EinvoiceSettings) {
  const p = integrators[s.provider];
  const secret = s.credentialsEnc ? JSON.parse(decryptSecret(s.credentialsEnc, ctx)) as Record<string, string> : {};
  return { provider: s.provider, mode: s.mode, values: s.values, secretsSet: Object.fromEntries((p?.fields ?? []).filter((f) => f.secret).map((f) => [f.key, !!secret[f.key]])),
    efaturaSeries: s.efaturaSeries, earsivSeries: s.earsivSeries, profile: s.profile, senderAlias: s.senderAlias, check: s.check,
    integrators: Object.entries(integrators).map(([id, x]) => ({ id, name: x.name, website: x.website, docs: x.docs, verified: x.verified, fields: x.fields, hosts: x.hosts })) };
}

@Controller('admin/settings/einvoice') @UseGuards(PermissionGuard)
export class EinvoiceSettingsController {
  @Get() @Can('settings.view', 'billing.view')
  async get() { return view(await settings()); }

  @Put() @Can('billing.manage')
  async put(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const cur = await settings();
    const provider = typeof body?.provider === 'string' ? body.provider : cur.provider;
    const fields: Record<string, string> = {};
    if (provider !== 'none' && !integrators[provider]) fields.provider = 'INVALID_VALUE';
    const p = integrators[provider];
    const mode = body?.mode === 'live' ? 'live' : body?.mode === 'test' ? 'test' : cur.mode;
    const input = (body?.values ?? {}) as Record<string, unknown>;
    const oldSecret = cur.credentialsEnc && cur.provider === provider ? JSON.parse(decryptSecret(cur.credentialsEnc, ctx)) as Record<string, string> : {};
    const values: Record<string, string> = {}; const secret: Record<string, string> = {};
    for (const f of p?.fields ?? []) {
      const v = typeof input[f.key] === 'string' ? (input[f.key] as string).trim().slice(0, 500) : '';
      if (f.secret) { secret[f.key] = v || oldSecret[f.key] || ''; if (!secret[f.key] && !f.optional) fields[`values.${f.key}`] = 'REQUIRED'; }
      else { values[f.key] = v || (cur.provider === provider ? cur.values[f.key] ?? '' : ''); if (!values[f.key] && !f.optional) fields[`values.${f.key}`] = 'REQUIRED'; }
    }
    const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
    if (endpoint && !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/[\w./-]*)?$/i.test(endpoint)) fields['values.endpoint'] = 'INVALID_ENDPOINT';
    if (endpoint) values.endpoint = endpoint;
    const series = (k: 'efaturaSeries' | 'earsivSeries') => { const v = typeof body?.[k] === 'string' ? (body[k] as string).trim().toUpperCase() : cur[k]; if (!validPrefix(v)) fields[k] = 'INVALID_VALUE'; return v; };
    const efaturaSeries = series('efaturaSeries'), earsivSeries = series('earsivSeries');
    if (efaturaSeries === earsivSeries) fields.earsivSeries = 'INVALID_VALUE';
    const profile = body?.profile === 'TICARIFATURA' ? 'TICARIFATURA' : body?.profile === 'TEMELFATURA' ? 'TEMELFATURA' : cur.profile;
    const senderAlias = typeof body?.senderAlias === 'string' ? body.senderAlias.trim().slice(0, 200) : cur.senderAlias;
    if (provider !== 'none' && provider !== 'sandbox' && !(await getSettings('billing')).company.taxId) fields.provider = 'COMPANY_REQUIRED';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    const next: EinvoiceSettings = { provider, mode, values, credentialsEnc: Object.values(secret).some(Boolean) ? encryptSecret(JSON.stringify(secret), ctx) : null,
      efaturaSeries, earsivSeries, profile, senderAlias, check: provider === cur.provider && mode === cur.mode ? cur.check : null };
    await saveSettings('einvoice', next);
    await audit(req, 'settings.einvoice', 'success', req.user.id, { provider, mode });
    return view(next);
  }

  // Checks the account without issuing anything: asks whether our own tax number is an e-Fatura user.
  @Post('test') @HttpCode(200) @Can('billing.manage')
  async test(@Req() req: AuthedRequest) {
    const s = await settings();
    const c = credsOf(s);
    if (!c) throw apiError(409, 'EINVOICE_OFF', 'Choose an integrator first');
    const vkn = (await getSettings('billing')).company.taxId || '1234567890';
    let check: EinvoiceSettings['check'];
    try {
      const r = await integrators[s.provider].lookup(vkn, c);
      check = { ok: true, message: r.registered ? `e-Fatura: ${r.alias ?? ''}` : 'e-Arşiv', at: new Date().toISOString() };
    } catch (e) { check = { ok: false, message: String((e as Error)?.message ?? e).slice(0, 300), at: new Date().toISOString() }; }
    await saveSettings('einvoice', { ...s, check });
    await audit(req, 'settings.einvoice_test', check.ok ? 'success' : 'failure', req.user.id, { provider: s.provider });
    return { check };
  }
}

// The issued e-invoice as the integrator renders it (staff and the invoice's owner); a retry for staff.
@Controller() @UseGuards(SessionGuard)
export class EinvoiceDocumentController {
  @Get('billing/invoices/:id/einvoice.pdf')
  async pdf(@Req() req: AuthedRequest, @Res() reply: FastifyReply, @Param('id', ParseUUIDPipe) id: string) {
    const staff = req.user.permissions.includes('*') || req.user.permissions.includes('billing.view');
    const { rows: [inv] } = await pool.query("SELECT * FROM invoices WHERE id = $1 AND ($2 OR owner_id = $3) AND einvoice_status IN ('sent', 'accepted', 'cancelled')", [id, staff, req.user.id]);
    const s = await settings();
    const c = credsOf(s);
    const p = inv && integrators[inv.einvoice_provider];
    if (!inv || !c || !p?.pdf || inv.einvoice_provider !== s.provider) throw apiError(404, 'NOT_FOUND', 'No e-invoice document');
    const pdf = await p.pdf(inv.einvoice_provider === 'parasut' ? inv.einvoice_ref : inv.einvoice_uuid, inv.einvoice_profile === 'EARSIVFATURA' ? 'earsiv' : 'efatura', c).catch(() => null);
    if (!pdf) throw apiError(502, 'EINVOICE_UNAVAILABLE', 'The integrator did not return the document');
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${inv.number}.pdf"`).send(pdf);
  }

  @Post('admin/billing/invoices/:id/einvoice/retry') @HttpCode(200) @UseGuards(PermissionGuard) @Can('billing.manage')
  async retry(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await pool.query("UPDATE invoices SET einvoice_status = 'queued', einvoice_attempts = 0 WHERE id = $1 AND einvoice_status IN ('failed', 'rejected', 'none') AND status IN ('paid', 'partially_refunded', 'refunded') AND kind <> 'topup'", [id]);
    if (!rowCount) throw apiError(409, 'EINVOICE_NOT_RETRYABLE', 'Only a paid invoice whose e-invoice failed can be sent again');
    await audit(req, 'billing.einvoice_retry', 'success', req.user.id, { invoiceId: id });
    await sendQueued();
    const { rows: [inv] } = await pool.query('SELECT einvoice_status AS "einvoiceStatus", einvoice_error AS "einvoiceError", number FROM invoices WHERE id = $1', [id]);
    return inv;
  }
}
