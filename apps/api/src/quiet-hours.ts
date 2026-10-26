// Quiet hours: a daily window, in the person's own time zone, when notifications that buzz a phone (browser push,
// SMS, messaging apps) are not sent. The inbox and e-mail still get them, and security notices always go out.
export type QuietHours = { start: string; end: string; tz: string } | null;

const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
export function validQuietHours(v: unknown): QuietHours | 'invalid' {
  if (v === null) return null;
  const q = v as { start?: unknown; end?: unknown; tz?: unknown };
  if (typeof q?.start !== 'string' || typeof q.end !== 'string' || typeof q.tz !== 'string' || !hhmm.test(q.start) || !hhmm.test(q.end) || q.start === q.end) return 'invalid';
  try { new Intl.DateTimeFormat('en', { timeZone: q.tz }); } catch { return 'invalid'; }
  return { start: q.start, end: q.end, tz: q.tz };
}

// The window may cross midnight (22:00–07:00).
export function inQuietHours(q: QuietHours, now = new Date()) {
  if (!q) return false;
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: q.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return q.start < q.end ? t >= q.start && t < q.end : t >= q.start || t < q.end;
}

// Channels that are held back during quiet hours, and notices that are never held back.
export const loudChannels = new Set(['push', 'sms', 'chat']);
export const alwaysSent = (event: string) => event.startsWith('auth.');
