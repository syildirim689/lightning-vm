"use client";
// Says so when the browser loses its connection (actions would fail silently otherwise), and when it is back
// refreshes every list on the page so nothing stale is left.
import { toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { I } from './icon';

export default function ConnectionBanner() {
  const t = useTranslations('Connection');
  const client = useQueryClient();
  const [offline, setOffline] = useState(false);
  // The internet works but the panel's server does not answer: two failures in a row, so one blip shows nothing.
  const [unreachable, setUnreachable] = useState(false);
  const fails = useRef(0), down = useRef(false);
  useEffect(() => {
    setOffline(!navigator.onLine);
    const back = () => { fails.current = 0; down.current = false; setUnreachable(false); toast.success(t('back')); void client.invalidateQueries(); };
    const lost = () => setOffline(true);
    const up = () => { setOffline(false); back(); };
    const api = (e: Event) => {
      if ((e as CustomEvent<boolean>).detail) { fails.current = 0; if (down.current) back(); }
      else if (++fails.current >= 2 && !down.current && navigator.onLine) { down.current = true; setUnreachable(true); }
    };
    window.addEventListener('offline', lost);
    window.addEventListener('online', up);
    window.addEventListener('lvm:api', api);
    return () => { window.removeEventListener('offline', lost); window.removeEventListener('online', up); window.removeEventListener('lvm:api', api); };
  }, [client, t]);
  const shown = offline ? 'lost' : unreachable ? 'server' : null;
  return <AnimatePresence>{shown && <motion.div role="status" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
    className="fixed inset-x-4 top-16 z-50 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-danger/40 bg-overlay/95 px-4 py-3 shadow-xl backdrop-blur">
    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-danger/15 text-danger">{shown === 'lost' ? <I name="wifi-off" size={17}/> : <I name="server-off" size={17}/>}</span>
    <span className="min-w-0 text-sm"><span className="block font-semibold">{t(shown)}</span><span className="block text-xs text-muted">{t(`${shown}Help`)}</span></span>
  </motion.div>}</AnimatePresence>;
}
