"use client";
// Says so when the browser loses its connection (actions would fail silently otherwise), and when it is back
// refreshes every list on the page so nothing stale is left.
import { toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from './icon';

export default function ConnectionBanner() {
  const t = useTranslations('Connection');
  const client = useQueryClient();
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    setOffline(!navigator.onLine);
    const down = () => setOffline(true);
    const up = () => { setOffline(false); toast.success(t('back')); void client.invalidateQueries(); };
    window.addEventListener('offline', down);
    window.addEventListener('online', up);
    return () => { window.removeEventListener('offline', down); window.removeEventListener('online', up); };
  }, [client, t]);
  return <AnimatePresence>{offline && <motion.div role="status" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
    className="fixed inset-x-4 top-16 z-50 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-danger/40 bg-overlay/95 px-4 py-3 shadow-xl backdrop-blur">
    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-danger/15 text-danger"><I name="wifi-off" size={17}/></span>
    <span className="min-w-0 text-sm"><span className="block font-semibold">{t('lost')}</span><span className="block text-xs text-muted">{t('lostHelp')}</span></span>
  </motion.div>}</AnimatePresence>;
}
