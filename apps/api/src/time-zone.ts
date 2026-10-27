// An IANA time zone name the runtime knows (PostgreSQL and the host use the same names); anything else is null.
// Checked by shape first so nothing odd reaches Intl, SQL or the host agent.
export function validTimeZone(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(v)) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: v }); return v; } catch { return null; }
}
