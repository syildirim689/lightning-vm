"use client";
// A newcomer's first steps on "My servers": an SSH key, a first server, a way to be told when something happens,
// and two-factor. Each step links to where it is done; the card goes away when all are done or when hidden.
import { Button, ProgressBar } from '@heroui/react';
import { AnimatePresence, motion } from 'motion/react';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useMe } from '../lib/me';
import { useApiQuery } from '../lib/query';
import { I } from './icon';

const hiddenKey = 'lvm-first-steps-hidden';

export default function FirstSteps() {
  const t = useTranslations('FirstSteps');
  const me = useMe();
  const keys = useApiQuery<{ keys: unknown[] }>(['ssh-keys'], '/ssh-keys').data?.keys;
  const servers = useApiQuery<{ servers: unknown[] }>(['servers'], '/servers').data?.servers;
  const prefs = useApiQuery<{ pushDevices: number; chatConnections: number; phoneVerified: boolean }>(['notification-prefs'], '/notifications/preferences').data;
  const [hidden, setHidden] = useState(true);
  useEffect(() => { try { setHidden(localStorage.getItem(hiddenKey) === '1'); } catch { setHidden(false); } }, []);
  if (!me || !keys || !servers || !prefs) return null;
  const steps = [
    { key: 'sshKey', done: keys.length > 0, href: '/account?tab=keys', icon: 'key-round' },
    { key: 'server', done: servers.length > 0, href: '/order', icon: 'server' },
    { key: 'notify', done: prefs.pushDevices > 0 || prefs.chatConnections > 0 || prefs.phoneVerified, href: '/account?tab=notifications', icon: 'bell-ring' },
    { key: 'twoFactor', done: me.twoFactorEnabled, href: '/account?tab=security', icon: 'shield-check' },
  ];
  const done = steps.filter((s) => s.done).length;
  const hide = () => { setHidden(true); try { localStorage.setItem(hiddenKey, '1'); } catch { /* storage off */ } };
  return <AnimatePresence>
    {!hidden && done < steps.length && <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}
      aria-labelledby="first-steps" className="overflow-hidden rounded-3xl border border-accent/30 bg-gradient-to-br from-accent/10 via-surface to-surface p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="first-steps" className="flex items-center gap-2 font-semibold"><I name="rocket" size={18} className="text-accent"/>{t('title')}</h2>
          <p className="text-sm text-muted">{t('intro', { done, total: steps.length })}</p>
        </div>
        <Button size="sm" variant="ghost" onPress={hide}>{t('hide')}</Button>
      </div>
      <ProgressBar aria-label={t('intro', { done, total: steps.length })} value={(done / steps.length) * 100} size="sm" color="accent" className="mb-4">
        <ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>
      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((s) => <li key={s.key}>
          <NextLink href={s.href} className={`flex h-full min-h-14 items-center gap-3 rounded-2xl border p-3 transition-colors focus-visible:outline-2 focus-visible:outline-accent ${s.done ? 'border-success/30 bg-success/5' : 'border-border bg-surface hover:border-accent/60'}`}>
            <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${s.done ? 'bg-success text-success-foreground' : 'bg-accent/10 text-accent'}`}>
              <I name={s.done ? 'check' : s.icon} size={16}/></span>
            <span className="min-w-0 flex-1">
              <span className={`block text-sm font-medium ${s.done ? 'text-muted line-through' : ''}`}>{s.done && <span className="sr-only">✓ </span>}{t(`step.${s.key}.title` as 'step.sshKey.title')}</span>
              <span className="block text-xs text-muted">{t(`step.${s.key}.help` as 'step.sshKey.help')}</span>
            </span>
          </NextLink>
        </li>)}
      </ol>
    </motion.section>}
  </AnimatePresence>;
}
