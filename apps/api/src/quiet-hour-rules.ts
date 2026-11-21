// Pure rules of the "quietest hours" suggestion (no database; unit-tested in test/quiet-hour-rules.test.mjs): from the
// hourly load of a group of servers (all of them, those of one connection, those on one host) over the last weeks,
// the stretch of the week, and the stretch of the day, in which the group has been least busy. It is offered where
// staff plan work that disturbs servers: the panel's update window and a host's maintenance.
// Load is "busy vCPUs": each server's average CPU for the hour times its vCPUs, summed over the servers measured.
// Conservative like the schedule rule: an hour of the week counts only when it was seen in enough weeks, a stretch
// only when every hour in it counts, and too short a history concludes nothing.
import { slotOf } from './schedule-rules';

export const quietRule = {
  weeks: 4,        // how far back the history is read
  minDays: 21,     // days the history must span; fewer: "not enough data"
  minWeeks: 3,     // observations an hour of the week needs before it is compared
  hours: 2,        // length of the stretch that is looked for
};

export type LoadRow = { t: number; load: number; servers: number }; // t: start of the hour (ms, UTC)
// day: ISO weekday of the first hour (1 = Monday); time, end: "HH:00" local; load: mean busy vCPUs in the stretch.
export type QuietStretch = { day: number; time: string; end: string; hours: number; load: number };
export type QuietHours =
  | { enough: false; days: number }
  | { enough: true; days: number; weeks: number; servers: number; usual: number; peak: number;
      weekly: QuietStretch | null;                           // the quietest stretch of the whole week
      daily: (QuietStretch & { worst: number }) | null };    // the quietest at the same time every day; worst: its busiest day

const hhmm = (hour: number) => `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`;
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

// The week as 168 hours in a time zone: how often each was seen and its mean load (null when seen too rarely).
export function weekProfile(rows: LoadRow[], timeZone: string, rule = quietRule): { n: number; load: number | null }[] {
  const slots = Array.from({ length: 168 }, () => ({ n: 0, sum: 0 }));
  for (const r of rows) { const s = slots[slotOf(r.t, timeZone)]; s.n++; s.sum += r.load; }
  return slots.map((s) => ({ n: s.n, load: s.n >= rule.minWeeks ? s.sum / s.n : null }));
}

export function quietHours(rows: LoadRow[], timeZone: string, now: number, rule = quietRule): QuietHours {
  const from = now - rule.weeks * 7 * 86_400_000;
  const recent = rows.filter((r) => r.t >= from && r.t < now && Number.isFinite(r.load) && r.load >= 0);
  const days = recent.length ? Math.floor((now - Math.min(...recent.map((r) => r.t))) / 86_400_000) : 0;
  if (days < rule.minDays) return { enough: false, days };
  const profile = weekProfile(recent, timeZone, rule);
  const known = profile.flatMap((s) => (s.load === null ? [] : [s.load]));
  if (!known.length) return { enough: false, days };
  // The mean load of `rule.hours` hours from a slot of the week on; null when one of them was seen too rarely.
  const stretch = (start: number) => {
    const xs = Array.from({ length: rule.hours }, (_, k) => profile[(start + k) % 168].load);
    return xs.some((x) => x === null) ? null : mean(xs as number[]);
  };

  // Weekly: the first of the quietest stretches (a tie goes to the earlier one in the week, so the answer is stable).
  let weekly: QuietStretch | null = null;
  for (let s = 0; s < 168; s++) {
    const load = stretch(s);
    if (load !== null && (!weekly || load < weekly.load - 1e-9)) weekly = { day: Math.floor(s / 24) + 1, time: hhmm(s), end: hhmm(s + rule.hours), hours: rule.hours, load };
  }
  // Daily: the same hours on all seven days, judged by their mean and reported with the busiest of the seven.
  let daily: (QuietStretch & { worst: number }) | null = null;
  for (let h = 0; h < 24; h++) {
    const perDay = Array.from({ length: 7 }, (_, d) => stretch(d * 24 + h));
    if (perDay.some((x) => x === null)) continue;
    const load = mean(perDay as number[]);
    if (!daily || load < daily.load - 1e-9) daily = { day: 0, time: hhmm(h), end: hhmm(h + rule.hours), hours: rule.hours, load, worst: Math.max(...(perDay as number[])) };
  }
  return { enough: true, days, weeks: Math.max(...profile.map((s) => s.n)), servers: Math.round(mean(recent.map((r) => r.servers))),
    usual: mean(known), peak: Math.max(...known), weekly, daily };
}
