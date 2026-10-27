// What the statistics say in words (the page's highlights) and the series as CSV. Pure, so they are tested.
export type SeriesPoint = { at: string; created: number; deleted: number; signups: number; ticketsOpened: number; ticketsClosed: number; opsOk: number; opsFailed: number };
type Change = { value: number | null; change: number | null };
export type Highlight = { key: 'signupsUp' | 'signupsDown' | 'ticketsUp' | 'ticketsDown' | 'failures' | 'growth' | 'shrink' | 'peakDay' | 'quiet'; tone: 'success' | 'warning' | 'danger' | 'accent';
  values: Record<string, string | number> };

// At most four, the most telling first: failures, then support load, then growth.
export function highlights(k: { signups: Change; tickets: Change; servers: Change; successRate: Change }, series: SeriesPoint[]): Highlight[] {
  const out: Highlight[] = [];
  const big = (c: number | null) => c !== null && Math.abs(c) >= 20;
  if (k.successRate.value !== null && k.successRate.value < 95) out.push({ key: 'failures', tone: 'danger', values: { rate: Math.round((100 - k.successRate.value) * 10) / 10 } });
  if (big(k.tickets.change)) out.push({ key: k.tickets.change! > 0 ? 'ticketsUp' : 'ticketsDown', tone: k.tickets.change! > 0 ? 'warning' : 'success', values: { pct: Math.abs(k.tickets.change!) } });
  if (big(k.signups.change)) out.push({ key: k.signups.change! > 0 ? 'signupsUp' : 'signupsDown', tone: k.signups.change! > 0 ? 'success' : 'warning', values: { pct: Math.abs(k.signups.change!) } });
  const net = series.reduce((n, p) => n + p.created - p.deleted, 0);
  if (net !== 0) out.push({ key: net > 0 ? 'growth' : 'shrink', tone: net > 0 ? 'success' : 'warning', values: { n: Math.abs(net) } });
  const peak = series.reduce<SeriesPoint | null>((b, p) => (p.created > 0 && (!b || p.created > b.created) ? p : b), null);
  if (peak) out.push({ key: 'peakDay', tone: 'accent', values: { at: peak.at, n: peak.created } });
  if (!out.length) out.push({ key: 'quiet', tone: 'accent', values: {} });
  return out.slice(0, 4);
}

// RFC 4180: fields with a comma, quote or line break are quoted, quotes doubled.
const cell = (v: string | number) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export function seriesCsv(series: SeriesPoint[], header: string[]) {
  const rows = series.map((p) => [p.at, p.created, p.deleted, p.signups, p.ticketsOpened, p.ticketsClosed, p.opsOk, p.opsFailed]);
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
