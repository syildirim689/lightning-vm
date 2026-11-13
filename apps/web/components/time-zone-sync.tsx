"use client";
// Keeps the time zone the server renders dates in (cookie lvm-tz, read in i18n/request.ts) equal to the person's
// choice, or to their browser's zone when they chose none. A change re-renders the page once.
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { hasPendingEdits } from '../lib/edits';
import { useMe } from '../lib/me';
import { browserTimeZone } from './time-zone-picker';

export const tzCookie = 'lvm-tz';

export default function TimeZoneSync() {
  const me = useMe();
  const router = useRouter();
  useEffect(() => {
    if (!me) return;
    const want = me.timeZone ?? browserTimeZone();
    const has = document.cookie.split('; ').find((c) => c.startsWith(`${tzCookie}=`))?.slice(tzCookie.length + 1);
    if (has && decodeURIComponent(has) === want) return;
    document.cookie = `${tzCookie}=${encodeURIComponent(want)}; path=/; max-age=31536000; samesite=lax`;
    // Re-rendering from the server would throw away unsaved typing (and, with the session gone, leave the page);
    // the new zone then applies from the next page instead.
    if (!hasPendingEdits()) router.refresh();
  }, [me?.timeZone, me, router]);
  return null;
}
