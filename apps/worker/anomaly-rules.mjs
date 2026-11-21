// Usage anomalies, the rules (no database): a server whose CPU or network use departs sharply from its own recent
// baseline. Robust statistics (median and median absolute deviation), so one wild hour in the history neither hides
// nor fakes a departure; a minimum of history, below which nothing is concluded; and two thresholds (a higher one to
// open, a lower one to close), so a value near the line does not open and close with every run.
// A finding is a signal for a person to look at, not a verdict: the numbers behind it are always kept with it.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

// CPU: the last complete hours against the same time of day on earlier days. Hours are UTC buckets, so a clock change
// (summer time) moves a local daily pattern by one hour: the band of ±1 hour around the window absorbs it.
export const cpuRule = {
  baselineDays: 14,   // how far back the baseline reaches (the raw samples are kept that long)
  recentHours: 3,     // the window that is judged: the median of its hourly averages, so one spike hour is not a finding
  minRecent: 2,       // hours of that window that must have samples
  hourBand: 1,        // baseline: the window's hours of the day, widened by this many hours on each side
  minDays: 4,         // earlier days that must contribute to the baseline; fewer: "not enough data"
  minBaseline: 12,    // baseline hours needed in all
  minScale: 5,        // percentage points: on a flat baseline a ripple is not an anomaly
  openZ: 4,           // robust z-score at which a finding opens
  closeZ: 2,          // and below which an open one closes
  openDelta: 20,      // percentage points away from the usual needed to open
  closeDelta: 10,     // and below which an open one closes
  lowBaseline: 15,    // "unusually quiet" is only said of a server that is usually at least this busy (percent)
  lowRatio: 0.2,      // opens at or below this share of the usual
  lowCloseRatio: 0.5, // closes at or above this share
};

// Network: a day's bytes (in and out) against the days before it. The panel keeps traffic per day, not per hour.
export const trafficRule = {
  baselineDays: 14,    // days before yesterday that form the baseline
  minDays: 7,          // of which this many must exist (the server's first week is never judged)
  minScaleBytes: 1024 ** 3,   // 1 GiB: a quiet server's ripple is not an anomaly
  scaleOfUsual: 0.25,  // the spread is never taken as less than this share of the usual day
  floorBytes: 5 * 1024 ** 3,  // a day below 5 GiB is never a finding, whatever the baseline
  openZ: 4,
  closeZ: 2,
  openFactor: 3,       // at least this many times the usual day to open
};

// When a finding looks like what the abuse module watches for (worth a look by staff; not a finding of that module).
export const hintRule = { cpuPinned: 90, outboundShare: 0.9 };

export function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b), m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
// Median absolute deviation, scaled to stand in for a standard deviation (1.4826 for normally distributed data).
export function spread(values, mid = median(values)) {
  return mid === null ? null : 1.4826 * median(values.map((x) => Math.abs(x - mid)));
}
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

// hours: [{ t: start of the hour (ms), v: average CPU percent }], any order; now: ms; was: the open finding's
// direction ('high' | 'low') or null. Returns what holds now and the numbers behind it.
export function cpuAnomaly(hours, now, was = null, rule = cpuRule) {
  const end = Math.floor(now / HOUR) * HOUR;           // the hour in progress is not judged
  const start = end - rule.recentHours * HOUR;
  const recentRows = hours.filter((h) => h.t >= start && h.t < end && Number.isFinite(h.v));
  // The window's hours of the day, widened by the band, on the days before the window (not the hours just before it today).
  const want = new Set();
  for (let k = -rule.hourBand; k < rule.recentHours + rule.hourBand; k++) want.add((((start / HOUR + k) % 24) + 24) % 24);
  const base = hours.filter((h) => h.t < start - 12 * HOUR && h.t >= end - rule.baselineDays * DAY && Number.isFinite(h.v) && want.has((h.t / HOUR) % 24));
  const days = new Set(base.map((h) => Math.floor(h.t / DAY))).size;
  const none = { enough: false, state: null, recent: null, usual: null, scale: null, z: null, baseline: base.length, days };
  if (recentRows.length < rule.minRecent || base.length < rule.minBaseline || days < rule.minDays) return none;
  const recent = median(recentRows.map((h) => h.v));
  const usual = median(base.map((h) => h.v));
  const scale = Math.max(spread(base.map((h) => h.v), usual), rule.minScale);
  const z = (recent - usual) / scale, delta = recent - usual;
  let state = null;
  if (z >= rule.openZ && delta >= rule.openDelta) state = 'high';
  else if (was === 'high' && z >= rule.closeZ && delta >= rule.closeDelta) state = 'high';
  else if (usual >= rule.lowBaseline && z <= -rule.openZ && recent <= usual * rule.lowRatio) state = 'low';
  else if (was === 'low' && usual >= rule.lowBaseline && recent < usual * rule.lowCloseRatio) state = 'low';
  return { enough: true, state, recent: round(recent), usual: round(usual), scale: round(scale), z: round(z), baseline: base.length, days };
}

const dayMs = (day) => Date.parse(`${day}T00:00:00Z`);
// days: [{ day: 'YYYY-MM-DD', rx, tx }] for the days the server existed (a day without traffic is a row of zeros, a
// day before the server was created is no row); today: 'YYYY-MM-DD'. Judged is the larger of today so far and
// yesterday: a day still running can already be too much, but can never be called quiet.
export function trafficAnomaly(days, today, was = null, rule = trafficRule) {
  const t = dayMs(today);
  const total = (d) => Number(d.rx) + Number(d.tx);
  const of = (ms) => days.find((d) => dayMs(d.day) === ms);
  const base = days.filter((d) => dayMs(d.day) < t - DAY && dayMs(d.day) >= t - (rule.baselineDays + 1) * DAY).map(total);
  const candidates = [of(t), of(t - DAY)].filter(Boolean);
  const none = { enough: false, state: null, value: null, usual: null, scale: null, z: null, baseline: base.length, day: null, outShare: null };
  if (base.length < rule.minDays || !candidates.length) return none;
  const judged = candidates.reduce((a, b) => (total(b) > total(a) ? b : a));
  const value = total(judged);
  const usual = median(base);
  const scale = Math.max(spread(base, usual), usual * rule.scaleOfUsual, rule.minScaleBytes);
  const z = (value - usual) / scale;
  let state = null;
  if (value >= rule.floorBytes && z >= rule.openZ && value >= usual * rule.openFactor) state = 'high';
  else if (was === 'high' && value >= rule.floorBytes / 2 && z >= rule.closeZ) state = 'high';
  return { enough: true, state, value, usual: Math.round(usual), scale: Math.round(scale), z: round(z), baseline: base.length, day: judged.day, outShare: value > 0 ? round(Number(judged.tx) / value, 2) : null };
}

// What a finding resembles, for staff: CPU held near full (what the abuse module calls a mining suspicion once it lasts
// its own, longer window), or traffic that is nearly all outbound (a flood or mass mailing sends, it does not receive).
export function abuseHint(metric, direction, detail, rule = hintRule) {
  if (direction !== 'high') return null;
  if (metric === 'cpu' && Number(detail?.recent) >= rule.cpuPinned) return 'cpu_pinned';
  if (metric === 'network' && Number(detail?.outShare) >= rule.outboundShare) return 'outbound';
  return null;
}
