"use client";
// Background work at a glance, bottom right: what runs now (with its step) and what just finished.
// Each row opens the server it belongs to. Polls quickly only while something is running.
import { Ago } from './ui';
import { Button, ProgressBar, Spinner } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useNow, useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { can } from '../lib/permissions';
import { useErrorText } from '../lib/api';
import { useApiQuery } from '../lib/query';
import { I } from './icon';
import { mayLeave } from '../lib/edits';

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
const stepAt = (o: Op) => { const list = steps[o.kind]; const i = list ? list.indexOf(o.step ?? 'queued') : -1; return list && i >= 0 ? { i: i + 1, n: list.length - 1 } : null; };
const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const CLEARED = 'lvm:tasks-cleared';

export default function TaskManager({ permissions }: { permissions: string[] }) {
  const t = useTranslations('Tasks');
  const ts = useTranslations('Servers');
  const format = useFormatter();
  const { error } = useErrorText();
  const [cleared, setCleared] = useState<string[]>([]);
  const [said, setSaid] = useState('');
  useEffect(() => { try { setCleared(JSON.parse(sessionStorage.getItem(CLEARED) ?? '[]') as string[]); } catch { /* storage blocked */ } }, []);
  const router = useRouter();
  const client = useQueryClient();
  const staff = can(permissions, 'servers.view_all');
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  // Every second while the list is open and something runs (the time passed); otherwise once in ten.
  const now = useNow({ updateInterval: open ? 1_000 : 10_000 });
  const [running, setRunning] = useState(false);
  const q = useApiQuery<{ operations: Op[] }>(['tasks', all], `/operations/active${all ? '?scope=all' : ''}`, { refetchInterval: running ? 3_000 : 15_000 });
  const fetched = q.data?.operations ?? [];
  // Finished rows the person cleared stay away (for this browser tab).
  const ops = fetched.filter((o) => o.status === 'pending' || o.status === 'running' || !cleared.includes(o.id));
  const active = ops.filter((o) => o.status === 'pending' || o.status === 'running');
  const failed = ops.filter((o) => o.status === 'failed');
  useEffect(() => setRunning(active.length > 0), [active.length]);

  // When something finishes, the pages that show servers refresh themselves.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const done = ops.filter((o) => o.finishedAt).map((o) => o.id);
    const fresh = ops.filter((o) => o.finishedAt && !seen.current.has(o.id));
    if (fresh.length && seen.current.size) {
      client.invalidateQueries({ queryKey: ['servers'] });
      // Said once for screen readers.
      const o = fresh[0];
      setSaid(t(o.status === 'failed' ? 'saidFailed' : 'saidDone', { task: ts(`kind.${o.kind as 'create'}`), server: o.serverName ?? '' }));
    }
    done.forEach((id) => seen.current.add(id));
  }, [ops, client]);

  function clear() {
    const next = [...new Set([...cleared, ...ops.filter((o) => o.finishedAt).map((o) => o.id)])].slice(-300);
    setCleared(next);
    try { sessionStorage.setItem(CLEARED, JSON.stringify(next)); } catch { /* storage blocked */ }
  }
  if (!ops.length && !all) return <span role="status" className="sr-only">{said}</span>;
  const tone = (o: Op) => o.status === 'succeeded' ? 'text-success' : o.status === 'failed' ? 'text-danger' : o.status === 'cancelled' ? 'text-muted' : 'text-accent';
  const icon = (o: Op) => o.status === 'succeeded' ? <I name="circle-check" size={16}/> : o.status === 'failed' ? <I name="circle-x" size={16}/> : o.status === 'cancelled' ? <I name="square" size={14}/> : <Spinner size="sm" color="current"/>;

  return <div className="pointer-events-none fixed inset-x-2 bottom-2 z-40 flex flex-col items-end gap-2 pb-[env(safe-area-inset-bottom)] sm:inset-x-auto sm:bottom-4 sm:right-4">
    <span role="status" className="sr-only">{said}</span>
    <AnimatePresence>
      {open && <motion.section initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 420, damping: 32 }} aria-label={t('title')}
        className="pointer-events-auto w-full overflow-hidden rounded-2xl border border-border bg-overlay text-overlay-foreground shadow-2xl sm:w-[23rem]">
        <header className="flex items-center gap-2 border-b border-separator px-4 py-3">
          <p className="flex-1 text-sm font-semibold">{t('title')}</p>
          {staff && <Button size="sm" variant={all ? 'secondary' : 'ghost'} onPress={() => setAll((v) => !v)}>{all ? t('everyone') : t('mine')}</Button>}
          <Button isIconOnly size="sm" variant="ghost" aria-label={t('close')} onPress={() => setOpen(false)}><I name="chevron-down" size={16}/></Button>
        </header>
        <ul className="max-h-[50vh] divide-y divide-separator overflow-y-auto">
          {ops.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">{t('empty')}</li>}
          {ops.map((o) => <motion.li key={o.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <button type="button" onClick={() => { setOpen(false); if (mayLeave(`/servers/${o.serverId}`)) router.push(`/servers/${o.serverId}`); }}
              className="flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-default focus-visible:bg-default focus-visible:outline-none">
              <span className="flex items-center gap-2 text-sm">
                <span className={tone(o)}>{icon(o)}</span>
                <span className="font-medium">{o.serverName}</span>
                <span className="text-muted">· {ts(`kind.${o.kind as 'create'}`)}</span>
                <span className="ml-auto text-xs text-muted"><Ago at={o.finishedAt ?? o.createdAt}/></span>
              </span>
              <span className={`flex items-center justify-between gap-2 text-xs ${o.status === 'failed' ? 'text-danger' : 'text-muted'}`}>
                <span className="min-w-0">{o.status === 'failed' ? (o.errorCode ? error({ code: o.errorCode }) : ts('opStatus.failed'))
                  : o.status === 'succeeded' || o.status === 'cancelled' ? ts(`opStatus.${o.status}`) : ts(`step.${(o.step ?? 'queued') as 'queued'}`)}{o.attempts > 1 && ` · ${ts('attempt', { n: o.attempts })}`}
                  {!o.finishedAt && stepAt(o) && <span className="text-muted"> · {t('stepOf', stepAt(o)!)}</span>}</span>
                {!o.finishedAt && <span className="shrink-0 tabular-nums">{clock(now.getTime() - Date.parse(o.createdAt))}</span>}
              </span>
              {(o.status === 'pending' || o.status === 'running') && <ProgressBar aria-label={t('progress')} value={progress(o)} size="sm"><ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>}
            </button>
          </motion.li>)}
        </ul>
        {ops.some((o) => o.finishedAt) && <footer className="flex justify-end border-t border-separator px-3 py-2"><Button size="sm" variant="ghost" onPress={clear}><I name="check-check" size={14}/>{t('clear')}</Button></footer>}
      </motion.section>}
    </AnimatePresence>
    <motion.button type="button" layout onClick={() => setOpen((v) => !v)} aria-expanded={open} whileTap={{ scale: 0.96 }}
      className="pointer-events-auto flex min-h-11 items-center gap-2 rounded-full border border-border bg-overlay px-4 text-sm font-medium text-overlay-foreground shadow-lg outline-offset-2 hover:border-accent">
      {active.length ? <span aria-hidden><Spinner size="sm" color="current"/></span> : failed.length ? <span className="text-danger"><I name="circle-x" size={16}/></span> : <I name="list-checks" size={16}/>}
      <span aria-live="polite">{active.length ? t('running', { n: active.length }) : failed.length ? t('failedCount', { n: failed.length }) : t('recent', { n: ops.length })}</span>
    </motion.button>
  </div>;
}
