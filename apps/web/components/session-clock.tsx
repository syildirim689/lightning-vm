"use client";
// Five minutes before the browser session ends, a bar says when and why (lib/session-clock.ts). Where staying is
// possible, "Stay signed in" renews the session (POST /auth/stay); a session with a fixed end ("sign in as", a
// directory or single sign-on account, a role's session length) gets the reason and "Got it" instead. Nothing is
// extended without the click. After the end the panel's existing handling takes over (unsaved typing is kept on
// screen, components/session-expired.tsx). One timer, no extra request: /auth/me is already read every minute.
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiFetch, useErrorText } from '../lib/api';
import { useApiQuery } from '../lib/query';
import { clock, localEnd, untilWarning, warnNow, type SessionEnds } from '../lib/session-clock';
import type { User } from '../lib/session';
import { I } from './icon';

export default function SessionClock() {
  const t = useTranslations('SessionClock');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<User & { session?: SessionEnds | null }>(['me'], '/auth/me', { refetchInterval: 60_000 });
  const s = q.data?.session ?? null;
  const end = s ? localEnd(s, q.dataUpdatedAt) : null;
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = end !== null && warnNow(end, now, dismissed);
  // Wake up when the warning is due, then tick each second while it shows.
  useEffect(() => {
    if (end === null) return;
    if (shown) { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }
    const wait = untilWarning(end, Date.now());
    if (wait > 2 ** 31 - 1) return;
    const id = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(id);
  }, [end, shown]);
  if (!shown || !s || end === null) return null;
  const at = format.dateTime(new Date(end), { timeStyle: 'short' });
  async function stay() {
    setBusy(true);
    try {
      const r = await apiFetch<{ session: SessionEnds }>('/auth/stay', { method: 'POST' });
      client.setQueryData(['me'], (m: object | undefined) => (m ? { ...m, session: r.session } : m));
      toast.success(t('stayed', { at: format.dateTime(new Date(Date.now() + r.session.msLeft), { timeStyle: 'short' }) }));
    } catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <div role="alert" data-session-clock={s.kind}
    className="fixed inset-x-4 top-16 z-50 mx-auto flex max-w-lg flex-wrap items-center gap-3 rounded-2xl border border-warning/50 bg-overlay/95 px-4 py-3 text-overlay-foreground shadow-xl backdrop-blur">
    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-warning/15 text-warning"><I name="timer" size={17}/></span>
    <span className="min-w-0 flex-1 text-sm">
      <span className="block font-semibold">{t('title', { left: clock(end - now), at })}</span>
      <span className="block text-xs text-muted">{t(`why.${s.why}`)}</span>
    </span>
    {s.kind === 'renewable'
      ? <Button size="sm" className="min-h-11 sm:min-h-9" isPending={busy} onPress={() => void stay()}><I name="log-in" size={14}/>{t('stay')}</Button>
      : <Button size="sm" variant="secondary" className="min-h-11 sm:min-h-9" onPress={() => setDismissed(end)}>{t('ok')}</Button>}
    {s.kind === 'renewable' && <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-9" onPress={() => setDismissed(end)}>{t('later')}</Button>}
  </div>;
}
