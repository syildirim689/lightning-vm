import { pool } from './db';
// After a restore of an older backup the panel acts on nothing by itself until staff release it (install.sh sets the row).
let seen = { at: 0, held: false };
export async function restoreHold(): Promise<boolean> {
  if (Date.now() - seen.at < 15_000) return seen.held;
  const { rows } = await pool.query("SELECT 1 FROM maintenance_state WHERE key = 'restore_hold'").catch(() => ({ rows: [] }));
  seen = { at: Date.now(), held: rows.length > 0 };
  return seen.held;
}
export function forgetRestoreHold() { seen = { at: 0, held: false }; }
