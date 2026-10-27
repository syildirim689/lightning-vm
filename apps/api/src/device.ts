// A short, stable name for the browser and system behind a user agent ("Chrome · Windows"), for sign-in history
// and "new device" notices. Versions are left out so an update does not look like a new device.
const browsers: [RegExp, string][] = [[/Edg\//, 'Edge'], [/OPR\/|Opera/, 'Opera'], [/SamsungBrowser/, 'Samsung Internet'], [/Firefox\/|FxiOS/, 'Firefox'],
  [/CriOS|Chrome\//, 'Chrome'], [/Safari\//, 'Safari']];
const systems: [RegExp, string][] = [[/iPhone|iPad|iPod/, 'iOS'], [/Android/, 'Android'], [/Windows/, 'Windows'], [/Mac OS X|Macintosh/, 'macOS'], [/CrOS/, 'ChromeOS'], [/Linux/, 'Linux']];

export function deviceOf(agent: string | null | undefined) {
  const ua = agent ?? '';
  const b = browsers.find(([r]) => r.test(ua))?.[1] ?? 'Other';
  const s = systems.find(([r]) => r.test(ua))?.[1] ?? 'Other';
  return `${b} · ${s}`;
}
