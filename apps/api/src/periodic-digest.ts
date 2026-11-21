// The periodic digest: one message, weekly by default (or daily), on the weekday and at the hour a person chose in
// their own time zone, that says where things stand instead of one notice per event. Off unless turned on:
//  - staff (dashboard.view) turn their own on in Account → Notifications and get the panel's digest: the open
//    findings by severity, what opened and closed since the last digest, the accounts at payment risk, failed
//    operations and the capacity findings. Only what the person may see elsewhere (the same checks as the lists).
//  - customers get theirs (their servers' findings, the month's forecast, the upcoming renewal) only where the
//    administrator has turned the event on (Settings → Notifications, "account.digest", off by default) and the
//    customer then turned their own on.
// It is sent as an ordinary notification (admin.digest / account.digest): through the channels the person chose for
// it, within the administrator's policy, held back from phones during quiet hours like every other notice.
// A digest with nothing to say is not sent. Each period is worked out exactly once however many copies of the API
// run: the timer runs under a Redis lock like the billing and schedule timers, and each person's row is claimed by
// moving its `next_at` forward in one conditional UPDATE, so a second copy that got past the lock finds nothing due.
// Cost per run (every five minutes): one indexed statement for the rows due, at most 200 of them; per digest the
// statements of the insights list it summarises (the staff list is worked out once per run, not per person).
import { Body, Controller, Get, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { upcomingRenewal } from './billing';
import { budgetState } from './budget';
import { budgetForecast, costForecast } from './cost-forecast';
import { pool, redis } from './db';
import { changes, defaultSchedule, digestText, isEmpty, nextSlot, seenOf, validSchedule, type CustomerDigest, type Digest, type DigestSchedule, type Finding, type Seen, type StaffDigest } from './digest-rules';
import { apiError } from './errors';
import { customerInsights, maySeeFinding, staffInsights, type Insight } from './insights';
import { logEvent } from './log';
import { chatReady } from './chat-delivery';
import { channelsFor, notify, policies } from './notify';
import { riskAccounts } from './payment-risk';
import { can, permissionsOfMany } from './permissions';
import { restoreHold } from './restore-hold';
import { rateLimit } from './security';
import { mailReady, type Channel } from './settings-store';
import { validTimeZone } from './time-zone';

const DAY = 86_400_000;
export const RENEWAL_DAYS = 14;   // a renewal this close is "upcoming"
export const DIGEST_BATCH = 200;  // rows worked out per run; the rest wait for the next run, five minutes later
const CAPACITY = new Set(['POOL_NEARLY_FULL', 'POOL_FILLING', 'POOL_FORECAST']);

export type DigestKind = 'staff' | 'customer';
export const kindOf = (permissions: string[]): DigestKind => (can(permissions, 'dashboard.view') ? 'staff' : 'customer');
export const eventOf = (kind: DigestKind) => (kind === 'staff' ? 'admin.digest' : 'account.digest');

const finding = (i: Insight): Finding => ({ key: i.key, code: i.code, severity: i.severity, params: i.params });
const hiddenKeys = async (userId: string) => new Set((await pool.query('SELECT key FROM insight_dismissals WHERE user_id = $1 AND (until IS NULL OR until > now())', [userId])).rows.map((r) => r.key as string));

// What one run shares between the staff it writes to: the list and the risk accounts are the same for all of them.
type Shared = { insights?: Promise<Insight[]>; risk?: ReturnType<typeof riskAccounts> };

export async function buildDigest(u: { id: string; permissions: string[] }, since: Date, seen: Seen[] | null, shared: Shared = {}): Promise<{ digest: Digest; seen: Seen[] }> {
  const hidden = await hiddenKeys(u.id);
  if (kindOf(u.permissions) === 'staff') {
    const all = (await (shared.insights ??= staffInsights())).filter((i) => maySeeFinding(u.permissions, i)).map(finding);
    // Compared with everything the person may see, then without what they hid: hiding a finding does not "close" it.
    const { opened, closed } = changes(seen, all);
    const findings = all.filter((f) => !hidden.has(f.key));
    const risk = can(u.permissions, 'billing.view') ? await (shared.risk ??= riskAccounts()) : null;
    const failed = can(u.permissions, 'servers.view_all') || can(u.permissions, 'dashboard.view')
      ? (await pool.query("SELECT count(*)::int AS n FROM operations WHERE status = 'failed' AND created_at > $1", [since])).rows[0].n as number : null;
    const digest: StaffDigest = { kind: 'staff', since: since.toISOString(), first: !seen, findings, opened: opened.filter((f) => !hidden.has(f.key)), closed,
      risk: risk && { accounts: risk.length, top: risk.slice(0, 3).map((r) => ({ email: r.email, amount: r.atRisk.toFixed(2), currency: r.currency })) },
      failedOperations: failed, capacity: findings.filter((f) => CAPACITY.has(f.code)) };
    return { digest, seen: seenOf(all) };
  }
  const all = (await customerInsights(u.id)).map(finding);
  const { opened, closed } = changes(seen, all);
  const findings = all.filter((f) => !hidden.has(f.key));
  const [costs, state, up] = await Promise.all([costForecast(u.id), budgetState(u.id), upcomingRenewal(u.id).catch(() => null)]);
  const budget = await budgetForecast(u.id, state, costs);
  const at = up?.renewal ? new Date(up.renewal.at).getTime() : NaN;
  const digest: CustomerDigest = { kind: 'customer', since: since.toISOString(), first: !seen, findings, opened: opened.filter((f) => !hidden.has(f.key)), closed,
    forecast: costs.map((c) => ({ currency: c.currency, accrued: c.accrued.toFixed(2), forecast: c.forecast.toFixed(2),
      budget: budget && budget.currency === c.currency ? budget.amount.toFixed(2) : null, state: budget && budget.currency === c.currency ? budget.forecastState : null })),
    renewal: up?.renewal && !up.renewal.invoiced && at > Date.now() && at - Date.now() <= RENEWAL_DAYS * DAY
      ? { date: new Date(at).toISOString().slice(0, 10), amount: Number(up.renewal.amount).toFixed(2), currency: up.renewal.currency } : null };
  return { digest, seen: seenOf(all) };
}

// Of the channels chosen, those that would deliver now: mail only where outgoing mail is set up, messaging apps only
// where they are on and the person has connected one. The inbox always works.
async function reach(userId: string, chosen: Channel[]): Promise<Channel[]> {
  const out: Channel[] = [];
  for (const c of chosen) {
    if (c === 'inApp') out.push(c);
    else if (c === 'email') { if (await mailReady()) out.push(c); }
    else if (c === 'chat') { if ((await chatReady()) && (await pool.query('SELECT 1 FROM chat_connections WHERE user_id = $1 AND enabled LIMIT 1', [userId])).rowCount) out.push(c); }
  }
  return out;
}

const send = (kind: DigestKind, userId: string, digest: Digest, preview = false) => notify(eventOf(kind), [userId], { payload: JSON.stringify(digest), preview: preview ? '1' : '' });
const periodOf = (s: { frequency: string }) => (s.frequency === 'daily' ? DAY : 7 * DAY);

// One run: everyone whose digest is due. Returns what it did, for the log and the tests.
export async function runDigests(now = new Date(), limit = DIGEST_BATCH) {
  const out = { due: 0, sent: 0, empty: 0, skipped: 0, failed: 0 };
  const { rows } = await pool.query(`SELECT d.user_id AS id, d.frequency, d.day, d.hour, d.timezone, d.next_at, d.last_run_at, d.seen
    FROM digest_preferences d JOIN users u ON u.id = d.user_id
    WHERE d.enabled AND d.next_at <= $1 AND NOT coalesce(u.banned, false) AND u.disabled_at IS NULL ORDER BY d.next_at LIMIT $2`, [now, limit]);
  if (!rows.length) return out;
  const people = new Map((await permissionsOfMany(rows.map((r) => r.id))).map((u) => [u.id, u]));
  const policy = await policies();
  const shared: Shared = {};
  for (const r of rows) {
    // The claim: only one copy moves this row past the period, and only that one goes on.
    const { rowCount } = await pool.query('UPDATE digest_preferences SET next_at = $2, last_run_at = $3 WHERE user_id = $1 AND enabled AND next_at <= $3',
      [r.id, new Date(nextSlot(r as DigestSchedule, now.getTime())), now]);
    if (!rowCount) continue;
    out.due++;
    const u = people.get(r.id);
    const kind = u && kindOf(u.permissions);
    // The administrator turned the event off since (or never on, for customers): the period passes without a digest.
    if (!u || !kind || !policy[eventOf(kind)]?.enabled) { out.skipped++; continue; }
    try {
      const since = r.last_run_at ? new Date(r.last_run_at) : new Date(now.getTime() - periodOf(r));
      const built = await buildDigest(u, since, r.last_run_at ? (r.seen as Seen[]) : null, shared);
      await pool.query('UPDATE digest_preferences SET seen = $2::jsonb, last_sent_at = CASE WHEN $3 THEN $4 ELSE last_sent_at END WHERE user_id = $1', [r.id, JSON.stringify(built.seen), !isEmpty(built.digest), now]);
      if (isEmpty(built.digest)) { out.empty++; continue; }
      await send(kind, r.id, built.digest);
      out.sent++;
    } catch (e) {
      out.failed++;
      logEvent('error', 'digest_failed', { error: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
    }
  }
  if (out.due) logEvent('info', 'digests', out);
  return out;
}

export function startPeriodicDigests() {
  const run = async () => {
    if (!(await redis.set('lock:digest', '1', 'EX', 240, 'NX').catch(() => null))) return;
    // Restored from an older backup: what the panel would summarise is from then; the digests wait for the release.
    if (await restoreHold()) return;
    await runDigests().catch(() => logEvent('error', 'digests_failed'));
  };
  return setInterval(run, 5 * 60_000).unref();
}

@Controller('account/digest') @UseGuards(SessionGuard)
export class PeriodicDigestController {
  private async state(req: AuthedRequest) {
    const kind = kindOf(req.user.permissions);
    const event = eventOf(kind);
    const policy = (await policies())[event];
    const { rows: [d] } = await pool.query('SELECT enabled, frequency, day, hour, timezone, next_at, last_sent_at FROM digest_preferences WHERE user_id = $1', [req.user.id]);
    return { kind, event, policy, row: d as { enabled: boolean; frequency: 'daily' | 'weekly'; day: number; hour: number; timezone: string; next_at: Date | null; last_sent_at: Date | null } | undefined };
  }

  // available: whether this person can have a digest at all (customers: only where the administrator turned it on).
  // channels: the person's choice for the event, within the administrator's policy; reach: those of them that would
  // deliver as things stand (mail set up, a messaging app connected).
  @Get()
  async read(@Req() req: AuthedRequest) {
    const { kind, event, policy, row } = await this.state(req);
    const channels = await channelsFor(req.user.id, event, policy);
    return { kind, event, available: policy.enabled, enabled: !!row?.enabled && policy.enabled, frequency: row?.frequency ?? defaultSchedule.frequency, day: row?.day ?? defaultSchedule.day,
      hour: row?.hour ?? defaultSchedule.hour, timezone: row?.timezone ?? validTimeZone(req.user.timeZone) ?? null, nextAt: row?.enabled && policy.enabled ? row.next_at : null,
      lastSentAt: row?.last_sent_at ?? null, channels, reach: await reach(req.user.id, channels) };
  }

  @Put()
  async save(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    // A digest keeps arriving after the session that set it up: not for staff acting as someone.
    if (req.user.impersonatedBy) throw apiError(403, 'NOT_WHILE_IMPERSONATING', 'Not while acting as another user');
    if (typeof body?.enabled !== 'boolean') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { enabled: 'INVALID_VALUE' });
    const s = validSchedule(body, validTimeZone);
    if ('fields' in s) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', s.fields);
    const { policy } = await this.state(req);
    if (body.enabled && !policy.enabled) throw apiError(409, 'DIGEST_NOT_AVAILABLE', 'The digest is not turned on in this panel');
    const next = body.enabled ? new Date(nextSlot(s, Date.now())) : null;
    // Turned on, or its time changed: the next digest is the next time the clock passes the chosen hour. What was
    // seen at the last digest is kept, so "opened and closed since" stays true across a change of the hour.
    await pool.query(`INSERT INTO digest_preferences (user_id, enabled, frequency, day, hour, timezone, next_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id) DO UPDATE SET enabled = $2, frequency = $3, day = $4, hour = $5, timezone = $6, next_at = $7, updated_at = now()`,
    [req.user.id, body.enabled, s.frequency, s.day, s.hour, s.timezone, next]);
    await audit(req, 'account.digest', 'success', req.user.id, { enabled: body.enabled, ...s });
    return this.read(req);
  }

  // "Send me a preview now": the digest as it would be written at this moment, through the same channels. It does
  // not count as a period (the next digest still compares with the last real one). Nothing to say: nothing is sent,
  // and the answer says so. The words are returned as well, so the page can show them where no channel is set: in
  // the account's language as they are sent (title, body), and in both (texts), so the page can show its own.
  @Post('preview') @HttpCode(200)
  async preview(@Req() req: AuthedRequest) {
    if (req.user.impersonatedBy) throw apiError(403, 'NOT_WHILE_IMPERSONATING', 'Not while acting as another user');
    const { kind, event, policy } = await this.state(req);
    if (!policy.enabled) throw apiError(409, 'DIGEST_NOT_AVAILABLE', 'The digest is not turned on in this panel');
    await rateLimit(`digest-preview:${req.user.id}`, 5, 3600);
    const { rows: [d] } = await pool.query('SELECT frequency, last_run_at, seen FROM digest_preferences WHERE user_id = $1', [req.user.id]);
    const since = d?.last_run_at ? new Date(d.last_run_at) : new Date(Date.now() - periodOf({ frequency: d?.frequency ?? defaultSchedule.frequency }));
    const { digest } = await buildDigest(req.user, since, d?.last_run_at ? (d.seen as Seen[]) : null);
    const empty = isEmpty(digest);
    const channels = await reach(req.user.id, await channelsFor(req.user.id, event, policy));
    if (!empty && channels.length) await send(kind, req.user.id, digest, true);
    await audit(req, 'account.digest_preview', 'success', req.user.id, { empty, channels });
    const texts = { tr: digestText('tr', digest, true), en: digestText('en', digest, true) };
    return { sent: !empty && channels.length > 0, empty, channels, ...texts[req.user.locale === 'tr' ? 'tr' : 'en'], texts };
  }
}
