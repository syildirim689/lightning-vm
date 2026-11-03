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
