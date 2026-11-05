// The next time an enabled schedule fires, for schedules kept in this browser's zone (the usual case: they are
// saved in it); within the next 8 days.
type Due = { enabled: boolean; timezone: string; time: string; days: number[] };
export function nextRun<S extends Due>(list: S[], zone: string, now = new Date()) {
  let best: { s: S; at: Date } | null = null;
  for (const s of list) {
    if (!s.enabled || s.timezone !== zone) continue;
    const [h, m] = s.time.split(':').map(Number);
    for (let k = 0; k < 8; k++) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k, h, m);
      if (at > now && s.days.includes(((at.getDay() + 6) % 7) + 1)) { if (!best || at < best.at) best = { s, at }; break; }
    }
  }
  return best;
}

// The same job twice: one action, time, zone and set of days.
type Job = { action: string; time: string; timezone: string; days: number[] };
export const sameJob = (a: Job, b: Job) => a.action === b.action && a.time === b.time && a.timezone === b.timezone && [...a.days].sort().join() === [...b.days].sort().join();

// Start and shut down at the same minute on a shared day: which one wins is a race, so it is worth a warning.
export function clashes<S extends Job & { enabled: boolean }>(list: S[]) {
  const on = list.filter((s) => s.enabled && s.action === 'power_on'), off = list.filter((s) => s.enabled && s.action === 'shutdown');
  return on.flatMap((a) => off.filter((b) => b.time === a.time && b.timezone === a.timezone && b.days.some((d) => a.days.includes(d))).map((b) => ({ time: a.time, days: a.days.filter((d) => b.days.includes(d)) })));
}
