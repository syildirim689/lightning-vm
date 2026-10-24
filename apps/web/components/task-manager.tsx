"use client";
// Background work at a glance, bottom right: what runs now (with its step) and what just finished.
// Each row opens the server it belongs to. Polls quickly only while something is running.
import { Button, ProgressBar, Spinner } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useNow, useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { can } from '../lib/permissions';
import { useApiQuery } from '../lib/query';
import { I } from './icon';

type Op = { id: string; kind: string; status: string; step: string | null; attempts: number; errorCode: string | null; createdAt: string; finishedAt: string | null; serverId: string; serverName: string };
const steps: Record<string, string[]> = {
  create: ['queued', 'clone', 'power_on', 'readiness', 'done'],
  delete: ['queued', 'destroy', 'verify_gone', 'done'],
};
const progress = (o: Op) => {
  if (o.status !== 'pending' && o.status !== 'running') return 100;
  const list = steps[o.kind] ?? ['queued', o.kind, 'done'];
  const i = Math.max(0, list.indexOf(o.step ?? 'queued'));
  return Math.round(((i + 0.5) / list.length) * 100);
};

export default function TaskManager({ permissions }: { permissions: string[] }) {
  const t = useTranslations('Tasks');
  const ts = useTranslations('Servers');
  const format = useFormatter();
  const now = useNow({ updateInterval: 10_000 });
  const router = useRouter();
  const client = useQueryClient();
  const staff = can(permissions, 'servers.view_all');
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const q = useApiQuery<{ operations: Op[] }>(['tasks', all], `/operations/active${all ? '?scope=all' : ''}`, { refetchInterval: running ? 3_000 : 15_000 });
  const ops = q.data?.operations ?? [];
  const active = ops.filter((o) => o.status === 'pending' || o.status === 'running');
  useEffect(() => setRunning(active.length > 0), [active.length]);

  // When something finishes, the pages that show servers refresh themselves.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const done = ops.filter((o) => o.finishedAt).map((o) => o.id);
    if (done.some((id) => !seen.current.has(id)) && seen.current.size) client.invalidateQueries({ queryKey: ['servers'] });
    done.forEach((id) => seen.current.add(id));
  }, [ops, client]);

  if (!ops.length && !all) return null;
  const tone = (o: Op) => o.status === 'succeeded' ? 'text-success' : o.status === 'failed' ? 'text-danger' : o.status === 'cancelled' ? 'text-muted' : 'text-accent';
  const icon = (o: Op) => o.status === 'succeeded' ? <I name="circle-check" size={16}/> : o.status === 'failed' ? <I name="circle-x" size={16}/> : o.status === 'cancelled' ? <I name="square" size={14}/> : <Spinner size="sm" color="current"/>;

  return <div className="fixed bottom-4 right-4 z-40 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2 pb-[env(safe-area-inset-bottom)]">
    <AnimatePresence>
      {open && <motion.section initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 420, damping: 32 }} aria-label={t('title')}
        className="w-[22rem] max-w-full overflow-hidden rounded-2xl border border-border bg-overlay text-overlay-foreground shadow-2xl">
        <header className="flex items-center gap-2 border-b border-separator px-4 py-3">
          <p className="flex-1 text-sm font-semibold">{t('title')}</p>
          {staff && <Button size="sm" variant={all ? 'secondary' : 'ghost'} onPress={() => setAll((v) => !v)}>{all ? t('everyone') : t('mine')}</Button>}
          <Button isIconOnly size="sm" variant="ghost" aria-label={t('close')} onPress={() => setOpen(false)}><I name="chevron-down" size={16}/></Button>
        </header>
        <ul className="max-h-[50vh] divide-y divide-separator overflow-y-auto">
          {ops.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">{t('empty')}</li>}
          {ops.map((o) => <motion.li key={o.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <button type="button" onClick={() => { setOpen(false); router.push(`/servers/${o.serverId}`); }}
              className="flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-default focus-visible:bg-default focus-visible:outline-none">
              <span className="flex items-center gap-2 text-sm">
                <span className={tone(o)}>{icon(o)}</span>
                <span className="font-medium">{o.serverName}</span>
                <span className="text-muted">· {ts(`kind.${o.kind as 'create'}`)}</span>
                <span className="ml-auto text-xs text-muted">{format.relativeTime(new Date(o.finishedAt ?? o.createdAt), now)}</span>
              </span>
              <span className="text-xs text-muted">{o.status === 'failed' ? `${ts(`opStatus.failed`)} · ${o.errorCode ?? ''}`
                : o.status === 'succeeded' || o.status === 'cancelled' ? ts(`opStatus.${o.status}`) : ts(`step.${(o.step ?? 'queued') as 'queued'}`)}{o.attempts > 1 && ` · ${ts('attempt', { n: o.attempts })}`}</span>
              {(o.status === 'pending' || o.status === 'running') && <ProgressBar aria-label={t('progress')} value={progress(o)} size="sm"><ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>}
            </button>
          </motion.li>)}
        </ul>
      </motion.section>}
    </AnimatePresence>
    <motion.button type="button" layout onClick={() => setOpen((v) => !v)} aria-expanded={open} whileTap={{ scale: 0.96 }}
      className="flex min-h-11 items-center gap-2 rounded-full border border-border bg-overlay px-4 text-sm font-medium text-overlay-foreground shadow-lg outline-offset-2 hover:border-accent">
      {active.length ? <span aria-hidden><Spinner size="sm" color="current"/></span> : <I name="list-checks" size={16}/>}
      <span aria-live="polite">{active.length ? t('running', { n: active.length }) : t('recent', { n: ops.length })}</span>
    </motion.button>
  </div>;
}
