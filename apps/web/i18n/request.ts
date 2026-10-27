import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { isLocale, localeCookie, negotiateLocale } from './config';

const zoneOr = (v: string | undefined, fallback: string) => {
  if (!v || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(v)) return fallback;
  try { new Intl.DateTimeFormat('en', { timeZone: v }); return v; } catch { return fallback; }
};

export default getRequestConfig(async () => {
  const saved = (await cookies()).get(localeCookie)?.value;
  const locale = isLocale(saved) ? saved : negotiateLocale((await headers()).get('accept-language'));
  return {
    locale,
    // The person's zone (their choice, else their browser's), kept in a cookie by TimeZoneSync; else the server's default.
    timeZone: zoneOr((await cookies()).get('lvm-tz')?.value, process.env.APP_TIME_ZONE || 'UTC'),
    // Relative times ("5 minutes ago") count from the request; components that tick pass their own useNow().
    now: new Date(),
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
