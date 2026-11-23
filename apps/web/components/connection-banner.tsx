"use client";
// Says so when the browser loses its connection or the panel's server stops answering (actions would fail silently
// otherwise). While it lasts, every list stops polling (React Query's online state goes offline: nothing piles up,
// nothing is lost, forms keep what was typed), and one small request tries again with growing waits (lib/reconnect.ts),
// or at once with "Try now". The first answer resumes everything without a reload and refreshes what is on screen.
import { Button, toast } from '@heroui/react';
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isBack, retryDelay, secondsLeft } from '../lib/reconnect';
import { I } from './icon';

export default function ConnectionBanner() {
  const t = useTranslations('Connection');
  const client = useQueryClient();
  const [offline, setOffline] = useState(false);
  // The internet works but the panel's server does not answer: two failures in a row, so one blip shows nothing.
  const [unreachable, setUnreachable] = useState(false);
  const fails = useRef(0), down = useRef(false);
  // The next attempt: when it is due and how many have failed so far.
  const [due, setDue] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const tries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [checking, setChecking] = useState(false);

  const back = useCallback(() => {
    clearTimeout(timer.current);
    const was = down.current || !onlineManager.isOnline();
    fails.current = 0; tries.current = 0; down.current = false;
    setUnreachable(false); setDue(null);
    onlineManager.setOnline(true);
    if (was) { toast.success(t('back')); void client.invalidateQueries(); }
  }, [client, t]);

  const probe = useCallback(async () => {
    clearTimeout(timer.current);
    setChecking(true);
    const status = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.status, () => null);
    setChecking(false);
    if (isBack(status) && navigator.onLine) { back(); return; }
    const wait = retryDelay(tries.current++);
    setDue(Date.now() + wait);
    timer.current = setTimeout(() => void probe(), wait);
  }, [back]);

  const lose = useCallback(() => {
    if (down.current) return;
    down.current = true;
    onlineManager.setOnline(false);
    tries.current = 0;
    const wait = retryDelay(0);
    setDue(Date.now() + wait);
    timer.current = setTimeout(() => void probe(), wait);
  }, [probe]);

  useEffect(() => {
    setOffline(!navigator.onLine);
    if (!navigator.onLine) lose();
    const lost = () => { setOffline(true); lose(); };
    const up = () => { setOffline(false); void probe(); };
    const api = (e: Event) => {
      if ((e as CustomEvent<boolean>).detail) { fails.current = 0; if (down.current) back(); }
      else if (++fails.current >= 2 && !down.current) { setUnreachable(true); lose(); }
    };
    window.addEventListener('offline', lost);
    window.addEventListener('online', up);
    window.addEventListener('lvm:api', api);
    return () => { window.removeEventListener('offline', lost); window.removeEventListener('online', up); window.removeEventListener('lvm:api', api); clearTimeout(timer.current); };
  }, [back, lose, probe]);

  // The countdown ticks only while the banner is up.
  const shown = offline ? 'lost' : unreachable ? 'server' : null;
  useEffect(() => {
    if (!shown || due === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [shown, due]);

  return <AnimatePresence>{shown && <motion.div role="status" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} data-connection={shown}
    className="fixed inset-x-4 top-16 z-50 mx-auto flex max-w-md flex-wrap items-center gap-3 rounded-2xl border border-danger/40 bg-overlay/95 px-4 py-3 shadow-xl backdrop-blur motion-reduce:transition-none">
    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-danger/15 text-danger">{shown === 'lost' ? <I name="wifi-off" size={17}/> : <I name="server-off" size={17}/>}</span>
    <span className="min-w-0 flex-1 text-sm"><span className="block font-semibold">{t(shown)}</span><span className="block text-xs text-muted">{t(`${shown}Help`)}</span>
      <span className="block text-xs text-muted" aria-live="off">{checking ? t('checking') : due !== null ? t('retryIn', { s: secondsLeft(due, now) }) : null}</span></span>
    <Button size="sm" variant="secondary" className="min-h-11 sm:min-h-9" isPending={checking} onPress={() => void probe()}><I name="refresh-cw" size={14}/>{t('tryNow')}</Button>
  </motion.div>}</AnimatePresence>;
}
