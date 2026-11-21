// Time zone names as PostgreSQL knows them. The runtime and the database do not know the same names: Node's list
// still carries names the time zone database has renamed (Asia/Calcutta, Europe/Kiev) and Java-style short ones
// (AET, PNT) that were never in it; a PostgreSQL built against a system without the old names refuses them, and a
// statement that reads the clock "AT TIME ZONE" of a stored name then fails as a whole. A name that is stored for
// SQL to use is therefore one the database itself accepts: the name given, or the other name of the same zone.
import { pool } from './db';
import { otherName, validTimeZone } from './time-zone';

// Asked once per name and process: the database's set of zones does not change while it runs.
const known = new Map<string, boolean>();
export async function databaseKnows(zone: string): Promise<boolean> {
  const hit = known.get(zone);
  if (hit !== undefined) return hit;
  // 22023 (invalid_parameter_value): "time zone ... not recognized". Any other failure is not an answer.
  const ok = await pool.query('SELECT now() AT TIME ZONE $1::text', [zone]).then(() => true, (e: { code?: string }) => { if (e?.code === '22023') return false; throw e; });
  if (known.size >= 2000) known.clear();
  known.set(zone, ok);
  return ok;
}

// The name to store where SQL will use it: valid for the runtime and known to the database, under its other name
// when the database only has that one; null when neither is.
export async function storedTimeZone(v: unknown): Promise<string | null> {
  const zone = validTimeZone(v);
  if (!zone) return null;
  if (await databaseKnows(zone)) return zone;
  const other = otherName(zone);
  return other && validTimeZone(other) && (await databaseKnows(other)) ? other : null;
}
