// Pure rules of the periodic digest (no database; unit-tested in test/digest-rules.test.mjs): when a person's next
// digest is due in their own time zone, what opened and closed between two digests, whether a digest has anything to
// say (an empty one is not sent), and its words in both languages. What goes into it is collected by
// periodic-digest.ts from what the panel already works out (insights, payment risk, the month's forecast).

export type DigestSchedule = { frequency: 'daily' | 'weekly'; day: number; hour: number; timezone: string }; // day: ISO weekday, 1 = Monday
export const defaultSchedule = { frequency: 'weekly' as const, day: 1, hour: 8 };

const formatters = new Map<string, Intl.DateTimeFormat>();
function local(t: number, timeZone: string): { day: number; minutes: number } {
  let f = formatters.get(timeZone);
  if (!f) {
    if (formatters.size >= 64) formatters.clear();
    f = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(t));
  const of = (type: string) => parts.find((p) => p.type === type)!.value;
  return { day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(of('weekday')) + 1, minutes: Number(of('hour')) * 60 + Number(of('minute')) };
}

// The first moment after `after` (ms) at which the person's clock passes the chosen hour (on the chosen weekday when
// weekly). Looked for in quarter-hour steps, so zones offset by 30 or 45 minutes work; where the clock is put forward
// over the chosen hour, it is the first moment after the gap; where it is put back, the first of the two.
const STEP = 15 * 60_000;
export function nextSlot(s: DigestSchedule, after: number): number {
  const wanted = s.hour * 60;
  const matches = (x: { day: number; minutes: number }) => (s.frequency === 'daily' || x.day === s.day) && x.minutes >= wanted;
  let t = Math.floor(after / STEP) * STEP;
  let before = local(t, s.timezone);
  // Nine days cover a week and a clock change; the loop always ends there.
  for (let i = 0; i < 9 * 96; i++) {
    t += STEP;
    const now = local(t, s.timezone);
    // Passed just now: at or after the hour on the right day, and the step before was not (an earlier time, or another day).
    if (matches(now) && !(before.day === now.day && before.minutes >= wanted)) return t;
    before = now;
  }
  return after + 7 * 86_400_000;
}

export function validSchedule(body: unknown, validZone: (v: unknown) => string | null): DigestSchedule | { fields: Record<string, string> } {
  const b = (body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const frequency = b.frequency === undefined ? defaultSchedule.frequency : b.frequency;
  if (frequency !== 'daily' && frequency !== 'weekly') fields.frequency = 'INVALID_VALUE';
  const day = b.day === undefined ? defaultSchedule.day : b.day;
  if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > 7) fields.day = 'INVALID_VALUE';
  const hour = b.hour === undefined ? defaultSchedule.hour : b.hour;
  if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23) fields.hour = 'INVALID_VALUE';
  const timezone = validZone(b.timezone);
  if (!timezone) fields.timezone = 'INVALID_VALUE';
  if (Object.keys(fields).length) return { fields };
  return { frequency: frequency as 'daily' | 'weekly', day: day as number, hour: hour as number, timezone: timezone! };
}

// ---- What a digest holds ----
export type Finding = { key: string; code: string; severity: 'danger' | 'warning' | 'info'; params: Record<string, string | number> };
export type Seen = { key: string; code: string; params?: Record<string, string | number> };
export type StaffDigest = {
  kind: 'staff'; since: string; first: boolean;
  findings: Finding[]; opened: Finding[]; closed: Seen[];
  risk: { accounts: number; top: { email: string; amount: string; currency: string }[] } | null; // null: not this person's to see
  failedOperations: number | null;
  capacity: Finding[]; // the pool findings (filling, nearly full, forecast), also part of `findings`
};
export type CustomerDigest = {
  kind: 'customer'; since: string; first: boolean;
  findings: Finding[]; opened: Finding[]; closed: Seen[];
  forecast: { currency: string; accrued: string; forecast: string; budget: string | null; state: 'ok' | 'near' | 'over' | null }[];
  renewal: { date: string; amount: string; currency: string } | null;
};
export type Digest = StaffDigest | CustomerDigest;

export const MAX_SEEN = 200;
// What opened and what closed since the findings seen at the last digest. The first digest has nothing to compare with.
export function changes(seen: Seen[] | null, now: Finding[]): { opened: Finding[]; closed: Seen[] } {
  if (!seen) return { opened: [], closed: [] };
  const before = new Set(seen.map((s) => s.key)), after = new Set(now.map((f) => f.key));
  return { opened: now.filter((f) => !before.has(f.key)), closed: seen.filter((s) => !after.has(s.key)) };
}
export const seenOf = (now: Finding[]): Seen[] => now.slice(0, MAX_SEEN).map(({ key, code, params }) => ({ key, code, params }));

// Nothing to say: no finding above "for information", nothing opened or closed since the last digest, and none of
// the figures the digest exists for. Standing notes ("two-factor is off") alone do not make a weekly message; the
// first digest lists them once.
export function isEmpty(d: Digest): boolean {
  if (d.findings.some((f) => f.severity !== 'info') || d.opened.length || d.closed.length || (d.first && d.findings.length)) return false;
  if (d.kind === 'staff') return !(d.risk?.accounts) && !d.failedOperations && !d.capacity.length;
  return !d.renewal && !d.forecast.some((f) => Number(f.forecast) > 0 || Number(f.accrued) > 0);
}

// ---- Words ----
type L = 'tr' | 'en';
type P = Record<string, string | number>;
const resource = (l: L, r: unknown) => (({ vcpu: { tr: 'vCPU', en: 'vCPU' }, memoryMb: { tr: 'bellek', en: 'memory' }, storageGb: { tr: 'disk', en: 'storage' }, servers: { tr: 'sunucu', en: 'servers' }, diskGb: { tr: 'disk', en: 'disk' } } as Record<string, Record<L, string>>)[String(r)]?.[l] ?? String(r));
// One line per insight code (apps/api/src/insights.ts); the panel's own cards say more, the digest says what and where.
export const labels: Record<string, Record<L, (p: P) => string>> = {
  RESTORE_HOLD: { tr: () => 'Panel yedekten geri yüklendi ve beklemede', en: () => 'The panel was restored from a backup and is on hold' },
  POOL_NEARLY_FULL: { tr: (p) => `${p.pool}: ${resource('tr', p.resource)} %${p.used} dolu`, en: (p) => `${p.pool}: ${resource('en', p.resource)} ${p.used}% used` },
  POOL_FILLING: { tr: (p) => `${p.pool}: ${resource('tr', p.resource)} %${p.used} dolu`, en: (p) => `${p.pool}: ${resource('en', p.resource)} ${p.used}% used` },
  POOL_FORECAST: { tr: (p) => `${p.pool}: bu gidişle ${resource('tr', p.resource)} yaklaşık ${p.days} günde dolar`, en: (p) => `${p.pool}: at this rate ${resource('en', p.resource)} is full in about ${p.days} days` },
  IP_POOL_EMPTY: { tr: (p) => `${p.pool}: boş IP adresi kalmadı`, en: (p) => `${p.pool}: no free IP address` },
  IP_POOL_LOW: { tr: (p) => `${p.pool}: ${p.free} boş IP adresi kaldı`, en: (p) => `${p.pool}: ${p.free} free IP addresses left` },
  CONNECTION_DOWN: { tr: (p) => `${p.connection} bağlantısına erişilemiyor${p.code ? ` (${p.code})` : ''}`, en: (p) => `Connection ${p.connection} is unreachable${p.code ? ` (${p.code})` : ''}` },
  OPERATIONS_STUCK: { tr: (p) => `${p.count} işlem süresini aştı`, en: (p) => `${p.count} operations are past their deadline` },
  OPERATIONS_FAILED: { tr: (p) => `Son 24 saatte ${p.count} işlem başarısız oldu`, en: (p) => `${p.count} operations failed in the last 24 hours` },
  OPERATIONS_NEED_DECISION: { tr: (p) => `${p.n} işlemin sonucu bilinmiyor; birinin bakması gerekiyor`, en: (p) => `${p.n} operations ended without a known outcome and need someone to look` },
  PAYMENTS_IN_REVIEW: { tr: (p) => `${p.n} ödeme personel kararı bekliyor`, en: (p) => `${p.n} payments wait for a decision by staff` },
  RECONCILE_FINDINGS: { tr: (p) => `Envanter karşılaştırmasında ${p.count} bulgu açık`, en: (p) => `${p.count} inventory reconciliation findings are open` },
  WORKER_DOWN: { tr: (p) => `Arka plan çalışanı ${p.minutes} dakikadır yanıt vermiyor`, en: (p) => `The background worker has not answered for ${p.minutes} minutes` },
  BACKUP_FAILED: { tr: (p) => `Son yedek başarısız${p.code ? ` (${p.code})` : ''}`, en: (p) => `The last backup failed${p.code ? ` (${p.code})` : ''}` },
  BACKUP_NEVER: { tr: () => 'Hiç başarılı yedek alınmamış', en: () => 'No backup has succeeded yet' },
  BACKUP_STALE: { tr: (p) => `Son başarılı yedek ${p.hours} saat önce`, en: (p) => `The last successful backup was ${p.hours} hours ago` },
  PACKAGE_UNSELLABLE: { tr: (p) => `${p.package} paketi hiçbir konuma sığmıyor`, en: (p) => `Package ${p.package} fits no location` },
  ADMINS_WITHOUT_2FA: { tr: (p) => `${p.count} yönetici iki adımlı doğrulama kullanmıyor`, en: (p) => `${p.count} administrators do not use two-factor authentication` },
  STAFF_INACTIVE: { tr: (p) => `${p.count} personel hesabı 90 gündür kullanılmıyor`, en: (p) => `${p.count} staff accounts have not been used for 90 days` },
  REGISTRATION_WITHOUT_CAPTCHA: { tr: () => 'Kayıt açık ama CAPTCHA yok', en: () => 'Registration is open without a CAPTCHA' },
  MAIL_NOT_CONFIGURED: { tr: () => 'E-posta gönderimi ayarlanmamış', en: () => 'Outgoing e-mail is not set up' },
  OVERSIZED_SERVERS: { tr: (p) => `${p.count} sunucu ayırdığından çok az işlemci kullanıyor (${p.vcpu} vCPU boşta)`, en: (p) => `${p.count} servers use far less CPU than they reserve (${p.vcpu} vCPUs spare)` },
  PAYMENT_RISK: { tr: (p) => `${p.count} hesap ödeme riski altında`, en: (p) => `${p.count} accounts are at payment risk` },
  USAGE_ANOMALIES: { tr: (p) => `${p.count} sunucuda olağan dışı kullanım${Number(p.suspicious) ? ` (${p.suspicious} tanesi kötüye kullanıma benziyor)` : ''}`, en: (p) => `Unusual use on ${p.count} servers${Number(p.suspicious) ? ` (${p.suspicious} resemble abuse)` : ''}` },
  // Customers
  SERVER_PROBLEM: { tr: (p) => `${p.name}: sunucuda sorun var`, en: (p) => `${p.name}: the server has a problem` },
  PENDING_DELETION: { tr: (p) => `${p.name}: yaklaşık ${p.hours} saat sonra silinecek`, en: (p) => `${p.name}: will be deleted in about ${p.hours} hours` },
  SERVER_OFF_LONG: { tr: (p) => `${p.name}: bir haftadan uzun süredir kapalı`, en: (p) => `${p.name}: switched off for over a week` },
  OFF_BUT_BILLED: { tr: (p) => `${p.name}: ${p.days} gündür kapalı, aylık ${p.price} ${p.currency} faturalanıyor`, en: (p) => `${p.name}: off for ${p.days} days and still billed ${p.price} ${p.currency} a month` },
  IDLE_SERVER: { tr: (p) => `${p.name}: neredeyse hiç kullanılmıyor (işlemci ortalaması %${p.avg})`, en: (p) => `${p.name}: hardly used (CPU averages ${p.avg}%)` },
  RIGHT_SIZE_DOWN: { tr: (p) => `${p.name}: ${p.vcpu} yerine ${p.suggested} vCPU yeter (ortalama %${p.avg})`, en: (p) => `${p.name}: ${p.suggested} vCPUs would do instead of ${p.vcpu} (average ${p.avg}%)` },
  RIGHT_SIZE_UP: { tr: (p) => `${p.name}: işlemcisi dar geliyor (ortalama %${p.avg}); ${p.suggested} vCPU önerilir`, en: (p) => `${p.name}: short of CPU (average ${p.avg}%); ${p.suggested} vCPUs suggested` },
  USAGE_ANOMALY_CPU_HIGH: { tr: (p) => `${p.name}: işlemci olağandan çok yüksek (%${p.recent}, olağanı %${p.usual})`, en: (p) => `${p.name}: CPU far above usual (${p.recent}%, usually ${p.usual}%)` },
  USAGE_ANOMALY_CPU_LOW: { tr: (p) => `${p.name}: işlemci olağandan çok düşük (%${p.recent}, olağanı %${p.usual})`, en: (p) => `${p.name}: CPU far below usual (${p.recent}%, usually ${p.usual}%)` },
  USAGE_ANOMALY_NETWORK_HIGH: { tr: (p) => `${p.name}: ağ trafiği olağandan çok yüksek (${p.recent} GB, olağan gün ${p.usual} GB)`, en: (p) => `${p.name}: network traffic far above usual (${p.recent} GB, a usual day is ${p.usual} GB)` },
  QUOTA_NEAR: { tr: (p) => `Kota: ${resource('tr', p.resource)} ${p.used} / ${p.max}`, en: (p) => `Quota: ${resource('en', p.resource)} ${p.used} of ${p.max}` },
  NO_FIREWALL: { tr: (p) => `${p.n} sunucuda firewall yok (ör. ${p.name})`, en: (p) => `${p.n} servers have no firewall (e.g. ${p.name})` },
  CARD_EXPIRES_BEFORE_RENEWAL: { tr: (p) => `Kayıtlı kartın (•••• ${p.last4}) süresi ${p.date} tarihli ${p.price} ${p.currency} yenilemeden önce doluyor`, en: (p) => `The saved card (•••• ${p.last4}) expires before the renewal of ${p.price} ${p.currency} on ${p.date}` },
  RENEWAL_NOT_COVERED: { tr: (p) => `Bakiye ${p.date} tarihli ${p.price} ${p.currency} yenilemeyi karşılamıyor (${p.short} ${p.currency} eksik)`, en: (p) => `The balance does not cover the renewal of ${p.price} ${p.currency} on ${p.date} (${p.short} ${p.currency} short)` },
  SCHEDULE_SUGGESTED: { tr: (p) => `${p.name}: haftada ${p.hours} saat boşta; güç zamanlaması önerildi`, en: (p) => `${p.name}: idle ${p.hours} hours a week; a power schedule is suggested` },
  BUDGET_FORECAST_OVER: { tr: (p) => `Bu ayın tahmini ${p.forecast} ${p.currency}, bütçe ${p.amount} ${p.currency}`, en: (p) => `This month is heading for ${p.forecast} ${p.currency} against a budget of ${p.amount} ${p.currency}` },
  BUDGET_FORECAST_NEAR: { tr: (p) => `Bu ayın tahmini bütçenin %${p.pct}'i (${p.forecast} / ${p.amount} ${p.currency})`, en: (p) => `This month's forecast is ${p.pct}% of the budget (${p.forecast} of ${p.amount} ${p.currency})` },
  SNAPSHOTS_OLD: { tr: (p) => `${p.n} anlık görüntü 30 günden eski`, en: (p) => `${p.n} snapshots are older than 30 days` },
  NO_SSH_KEYS: { tr: () => 'Hesapta kayıtlı SSH anahtarı yok', en: () => 'No SSH key is saved on the account' },
  ENABLE_2FA: { tr: () => 'İki adımlı doğrulama kapalı', en: () => 'Two-factor authentication is off' },
};
export const labelOf = (l: L, code: string, params: P = {}) => { try { return labels[code]?.[l](params) ?? code; } catch { return code; } };

const MAX_LINES = 8;
const severityWords: Record<Finding['severity'], Record<L, string>> = { danger: { tr: 'kritik', en: 'critical' }, warning: { tr: 'uyarı', en: 'warning' }, info: { tr: 'bilgi', en: 'informational' } };
const order = { danger: 0, warning: 1, info: 2 };
function listed<T extends { code: string; params?: P }>(l: L, items: T[], mark: (x: T) => string): string[] {
  const lines = items.slice(0, MAX_LINES).map((x) => `${mark(x)} ${labelOf(l, x.code, x.params)}`);
  if (items.length > MAX_LINES) lines.push(l === 'tr' ? `… ve ${items.length - MAX_LINES} tane daha` : `… and ${items.length - MAX_LINES} more`);
  return lines;
}
const day = (iso: string) => iso.slice(0, 10);

// Title and body (lines joined by a line break; the mail shows each as a paragraph, a chat message as lines).
export function digestText(l: L, d: Digest, preview = false): { title: string; body: string } {
  const tr = l === 'tr';
  const lines: string[] = [];
  const findings = [...d.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = (['danger', 'warning', 'info'] as const).map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
  lines.push(tr ? `${day(d.since)} tarihinden bugüne.` : `Since ${day(d.since)}.`);
  if (findings.length) {
    lines.push(`${tr ? 'Açık bulgular' : 'Open findings'}: ${counts.map(([s, n]) => `${n} ${severityWords[s][l]}`).join(', ')}`);
    lines.push(...listed(l, findings, (f) => (f.severity === 'danger' ? '(!)' : '-')));
  } else lines.push(tr ? 'Açık bulgu yok.' : 'No open findings.');
  if (!d.first) {
    if (d.opened.length) { lines.push(`${tr ? 'Son özetten beri açılan' : 'Opened since the last digest'}: ${d.opened.length}`); lines.push(...listed(l, d.opened, () => '+')); }
    if (d.closed.length) { lines.push(`${tr ? 'Son özetten beri kapanan' : 'Closed since the last digest'}: ${d.closed.length}`); lines.push(...listed(l, d.closed, () => '✓')); }
    if (!d.opened.length && !d.closed.length) lines.push(tr ? 'Son özetten beri açılan ya da kapanan bulgu yok.' : 'Nothing opened or closed since the last digest.');
  }
  if (d.kind === 'staff') {
    if (d.risk?.accounts) {
      lines.push(tr ? `Ödeme riski altındaki hesaplar: ${d.risk.accounts}` : `Accounts at payment risk: ${d.risk.accounts}`);
      for (const a of d.risk.top) lines.push(`- ${a.email}: ${a.amount} ${a.currency}`);
    }
    if (d.failedOperations) lines.push(tr ? `Başarısız işlemler: ${d.failedOperations}` : `Failed operations: ${d.failedOperations}`);
    if (d.capacity.length) { lines.push(tr ? 'Kapasite:' : 'Capacity:'); lines.push(...listed(l, d.capacity, () => '-')); }
  } else {
    for (const f of d.forecast) {
      const budget = f.budget ? (tr ? `; bütçe ${f.budget} ${f.currency}${f.state === 'over' ? ' (aşılıyor)' : f.state === 'near' ? ' (yaklaşıyor)' : ''}` : `; budget ${f.budget} ${f.currency}${f.state === 'over' ? ' (over)' : f.state === 'near' ? ' (close)' : ''}`) : '';
      lines.push(tr ? `Bu ay: şimdiye kadar ${f.accrued} ${f.currency}, ay sonu tahmini ${f.forecast} ${f.currency}${budget}` : `This month: ${f.accrued} ${f.currency} so far, ${f.forecast} ${f.currency} forecast by month end${budget}`);
    }
    if (d.renewal) lines.push(tr ? `Yaklaşan yenileme: ${d.renewal.date}, ${d.renewal.amount} ${d.renewal.currency}` : `Upcoming renewal: ${d.renewal.date}, ${d.renewal.amount} ${d.renewal.currency}`);
  }
  const what = d.kind === 'staff' ? (tr ? 'Panel özeti' : 'Panel digest') : (tr ? 'Hesap özetiniz' : 'Your account digest');
  const head = findings.length ? (tr ? `${findings.length} açık bulgu` : `${findings.length} open ${findings.length === 1 ? 'finding' : 'findings'}`) : (tr ? 'açık bulgu yok' : 'no open findings');
  return { title: `${preview ? (tr ? 'Önizleme: ' : 'Preview: ') : ''}${what}: ${head}`, body: lines.join('\n') };
}
