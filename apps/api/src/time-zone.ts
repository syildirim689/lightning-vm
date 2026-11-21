// An IANA time zone name the runtime knows; anything else is null.
// Checked by shape first so nothing odd reaches Intl, SQL or the host agent. No database here (unit tests load this
// file on its own): what PostgreSQL knows is asked in time-zone-db.ts.
export function validTimeZone(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(v)) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: v }); return v; } catch { return null; }
}

// Zones the time zone database has renamed: the runtime's own list still carries the old names (Asia/Calcutta,
// Europe/Kiev: what a browser in India or Ukraine reports), a database may know only one of the two.
const renamed: [string, string][] = [
  ['Africa/Asmera', 'Africa/Asmara'], ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'], ['America/Catamarca', 'America/Argentina/Catamarca'],
  ['America/Cordoba', 'America/Argentina/Cordoba'], ['America/Godthab', 'America/Nuuk'], ['America/Indianapolis', 'America/Indiana/Indianapolis'],
  ['America/Jujuy', 'America/Argentina/Jujuy'], ['America/Louisville', 'America/Kentucky/Louisville'], ['America/Mendoza', 'America/Argentina/Mendoza'],
  ['Asia/Calcutta', 'Asia/Kolkata'], ['Asia/Katmandu', 'Asia/Kathmandu'], ['Asia/Rangoon', 'Asia/Yangon'], ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
  ['Atlantic/Faeroe', 'Atlantic/Faroe'], ['Europe/Kiev', 'Europe/Kyiv'], ['Pacific/Enderbury', 'Pacific/Kanton'], ['Pacific/Ponape', 'Pacific/Pohnpei'], ['Pacific/Truk', 'Pacific/Chuuk'],
];
// The other name of the same zone, when it has one.
export const otherName = (zone: string) => { const pair = renamed.find((p) => p.includes(zone)); return pair ? (pair[0] === zone ? pair[1] : pair[0]) : null; };
