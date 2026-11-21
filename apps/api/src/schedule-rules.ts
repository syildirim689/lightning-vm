// Pure rules of the power schedule suggestion (no database; unit-tested in test/schedule-rules.test.mjs): from a
// server's hourly CPU history, the hours of the week in which it has been idle week after week, and the schedule
// (shut down at one time, start at another, on given weekdays) that would keep it off through them.
// Conservative on purpose: an hour without measurements counts as "in use", an hour is idle only when every week
// seen says so, and the server is started an hour before and stopped an hour after the hours it was seen in use.

export const scheduleRule = {
  weeks: 4,          // how far back the history is read
  minDays: 21,       // days the history must span; fewer: "not enough data"
  minWeeks: 3,       // observations an hour of the week needs before it can be called idle
  idleAvg: 3,        // percent: the hour's average CPU in every week seen must be below this
  idleMax: 10,       // percent: and its highest sample below this
  minNight: 6,       // hours a nightly window must have to be worth a schedule
  minBlock: 24,      // hours a once-a-week window (a weekend) must have
  margin: 1,         // hours the server is started before, and kept on after, the hours it was seen in use
  minOff: 20,        // hours off per week below which nothing is suggested
};

export type HourRow = { t: number; avg: number; max: number }; // t: start of the hour (ms, UTC)
export type Suggested = { action: 'shutdown' | 'power_on'; days: number[]; time: string };
export type ScheduleSuggestion =
  | { enough: false; reason: 'not_enough_data'; days: number }
  | { enough: true; reason: 'always_idle' | 'no_window'; days: number; idleHours: number }
  | { enough: true; reason: null; days: number; idleHours: number; kind: 'nightly' | 'weekly'; offHours: number; schedules: Suggested[] };

// The hour of the week (0 = Monday 00:00 ... 167 = Sunday 23:00) of a moment in a time zone. Local time, so a schedule
// follows the clock people live by; where the clock changes, one hour of one week is seen twice or not at all.
// One formatter per zone is kept: building one costs far more than using it, and a history has hundreds of rows
// (672 formatters for one suggestion held the API's only thread for a quarter of a second).
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterOf(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    if (formatters.size >= 64) formatters.clear(); // zones come from requests: the map stays small
    f = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, f);
  }
  return f;
}
export function slotOf(t: number, timeZone: string): number {
  const parts = formatterOf(timeZone).formatToParts(new Date(t));
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.find((p) => p.type === 'weekday')!.value);
  return day * 24 + Number(parts.find((p) => p.type === 'hour')!.value);
}

// Which of the 168 hours of the week were idle in every week seen (and seen often enough).
export function idleSlots(rows: HourRow[], timeZone: string, rule = scheduleRule): boolean[] {
  const seen = Array.from({ length: 168 }, () => ({ n: 0, busy: false }));
  for (const r of rows) {
    const s = seen[slotOf(r.t, timeZone)];
    s.n++;
    if (!(r.avg < rule.idleAvg && r.max < rule.idleMax)) s.busy = true;
  }
  return seen.map((s) => s.n >= rule.minWeeks && !s.busy);
}

const hhmm = (hour: number) => `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`;
const iso = (day: number) => (((day % 7) + 7) % 7) + 1; // 0 = Monday -> ISO 1

export function suggestSchedule(rows: HourRow[], timeZone: string, now: number, rule = scheduleRule): ScheduleSuggestion {
  const from = now - rule.weeks * 7 * 86_400_000;
  const recent = rows.filter((r) => r.t >= from && r.t < now && Number.isFinite(r.avg) && Number.isFinite(r.max));
  const days = recent.length ? Math.floor((now - Math.min(...recent.map((r) => r.t))) / 86_400_000) : 0;
  if (days < rule.minDays) return { enough: false, reason: 'not_enough_data', days };
  const idle = idleSlots(recent, timeZone, rule);
  const idleHours = idle.filter(Boolean).length;
  // Idle around the clock is not a schedule's business (the "idle server" advice covers it).
  if (idleHours === 168) return { enough: true, reason: 'always_idle', days, idleHours };

  // Nightly: the longest stretch of hours of the day (around midnight too) in which no weekday was in use.
  const busyHour = Array.from({ length: 24 }, (_, h) => Array.from({ length: 7 }, (_, d) => idle[d * 24 + h]).some((x) => !x));
  let best = { start: 0, length: 0 };
  for (let s = 0; s < 24; s++) {
    if (busyHour[s] || !busyHour[(s + 23) % 24]) continue; // a stretch begins after a busy hour
    let n = 0;
    while (n < 24 && !busyHour[(s + n) % 24]) n++;
    if (n > best.length) best = { start: s, length: n };
  }
  if (best.length - 2 * rule.margin >= rule.minNight) {
    const off = best.start + rule.margin;                      // shut down an hour after the last hour in use
    const on = (best.start + best.length - rule.margin) % 24;  // start an hour before the first
    const span = 24 - (best.length - 2 * rule.margin);         // hours the server is on, from `on`
    // The days it is needed at all: those whose "on" span has an hour in use. Other days it simply stays off.
    const needed = Array.from({ length: 7 }, (_, d) => d).filter((d) => Array.from({ length: span }, (_, k) => idle[(d * 24 + on + k) % 168]).some((x) => !x));
    const offHours = 168 - needed.length * span;
    if (needed.length && offHours >= rule.minOff) {
      // The shutdown of a span that began on day d falls on the same day, or on the next one when the span passes midnight.
      const nextDay = on + span >= 24 ? 1 : 0;
      return { enough: true, reason: null, days, idleHours, kind: 'nightly', offHours, schedules: [
        { action: 'shutdown', days: needed.map((d) => iso(d + nextDay)).sort(), time: hhmm(off) },
        { action: 'power_on', days: needed.map(iso).sort(), time: hhmm(on) }] };
    }
  }

  // Weekly: no nightly window, but one long idle stretch in the week (a weekend).
  let block = { start: 0, length: 0 };
  for (let s = 0; s < 168; s++) {
    if (!idle[s] || idle[(s + 167) % 168]) continue;
    let n = 0;
    while (n < 168 && idle[(s + n) % 168]) n++;
    if (n > block.length) block = { start: s, length: n };
  }
  const offHours = block.length - 2 * rule.margin;
  if (offHours >= rule.minBlock && offHours >= rule.minOff) {
    const off = (block.start + rule.margin) % 168, on = (block.start + block.length - rule.margin) % 168;
    return { enough: true, reason: null, days, idleHours, kind: 'weekly', offHours, schedules: [
      { action: 'shutdown', days: [iso(Math.floor(off / 24))], time: hhmm(off) },
      { action: 'power_on', days: [iso(Math.floor(on / 24))], time: hhmm(on) }] };
  }
  return { enough: true, reason: 'no_window', days, idleHours };
}
