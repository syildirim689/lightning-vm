import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { isLocale, localeCookie, negotiateLocale } from './config';

export default getRequestConfig(async () => {
  const saved = (await cookies()).get(localeCookie)?.value;
  const locale = isLocale(saved) ? saved : negotiateLocale((await headers()).get('accept-language'));
  return {
    locale,
    // shortcut: one server-wide zone, add a per-user time zone setting with user profiles.
    timeZone: process.env.APP_TIME_ZONE || 'UTC',
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
