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
// What remembers that staff were told about a hold (insights.ts, announceRestoreHold) goes when the hold is gone.
export const clearRestoreHoldNotice = () =>
  pool.query("DELETE FROM maintenance_state WHERE key = 'restore_hold_notified' AND NOT EXISTS (SELECT 1 FROM maintenance_state WHERE key = 'restore_hold')").then(() => undefined);
