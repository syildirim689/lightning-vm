"use client";
// What the panel's own server is doing after "restart" or "install updates" was asked for (Admin → System): a
// full-screen progress window with the steps, the time passed and what happens next. It asks the server itself
// every two seconds (with a short timeout, so nothing hangs while the server is down), survives a reload, and can
// be put aside: the work goes on in the server either way.
import { Button } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { I } from './icon';

export type HostTaskKind = 'reboot' | 'security' | 'upgrade';
type Task = { kind: HostTaskKind; at: number; prev: string | null; n: number };
type Answer = { uptime: number; os: { total: number; security: number; rebootRequired: boolean } | null;
  agent: { pending: number; setUp?: number; log: string[]; status: { id: string; state: 'running' | 'succeeded' | 'failed' | 'rejected'; code: string } | null } };
type Phase = 'queued' | 'closing' | 'down' | 'starting' | 'lists' | 'installing' | 'done' | 'signin' | 'failed';
const KEY = 'lvm:host-task', EVENT = 'lvm:host-task';
// A restart is over within minutes; an install may take as long as the agent lets apt run.
const lifetime = (k: HostTaskKind) => (k === 'reboot' ? 30 : 90) * 60_000;

// Called by the page that asked (os-updates.tsx): `prev` is the agent's last run before this one, `n` the packages to install.
export function startHostTask(kind: HostTaskKind, prev: string | null, n = 0) {
  const task: Task = { kind, at: Date.now(), prev, n };
  try { sessionStorage.setItem(KEY, JSON.stringify(task)); } catch { /* storage blocked: the window still opens */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: task }));
}

const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

export default function HostTask() {
  const t = useTranslations('HostTask');
  const [task, setTask] = useState<Task | null>(null);
  const [small, setSmall] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [phase, setPhase] = useState<Phase>('queued');
  const [last, setLast] = useState<Answer | null>(null);
  const [silent, setSilent] = useState(false); // the server does not answer right now
  const [closingAt, setClosingAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const sawDown = useRef(false);
  const fails = useRef(0);
  const main = useRef<HTMLButtonElement>(null);

  // Pick up a task started on this page, or one still running after a reload.
  useEffect(() => {
    const begin = (x: Task) => { sawDown.current = false; fails.current = 0; setPhase('queued'); setLast(null); setSilent(false); setClosingAt(null); setEndedAt(null); setSmall(false); setNow(Date.now()); setTask(x); };
    try {
      const kept = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Task | null;
      if (kept && typeof kept.at === 'number' && Date.now() - kept.at < lifetime(kept.kind)) begin(kept); else sessionStorage.removeItem(KEY);
    } catch { /* storage blocked */ }
    const on = (e: Event) => begin((e as CustomEvent<Task>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);

  const over = phase === 'done' || phase === 'failed' || phase === 'signin';
  useEffect(() => {
    if (!task || over) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    let stop = false, timer: ReturnType<typeof setTimeout>;
    const ask = async () => {
      let res: Response | null = null, body: Answer | null = null;
      try {
        res = await fetch('/api/admin/os', { headers: { 'x-lightning-csrf': '1' }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (res.ok) body = await res.json() as Answer;
      } catch { res = null; }
      if (stop) return;
      const elapsed = (Date.now() - task.at) / 1000;
      const mine = body?.agent.status && body.agent.status.id !== task.prev ? body.agent.status : null;
      if (!body) {
        fails.current += 1;
        if (fails.current >= 2) { setSilent(true); if (task.kind === 'reboot') { sawDown.current = true; setPhase(res ? 'starting' : 'down'); } }
        // Back, but the sign-in did not survive the restart.
        if (res && (res.status === 401 || res.status === 403) && sawDown.current) setPhase('signin');
      } else {
        fails.current = 0; setSilent(false); setLast(body);
        if (mine && (mine.state === 'failed' || mine.state === 'rejected')) setPhase('failed');
        else if (task.kind === 'reboot') {
          // The server was started after the request: it is back.
          if (body.uptime < elapsed) setPhase('done');
          else if (mine?.state === 'succeeded') { setClosingAt((c) => c ?? Date.now()); setPhase('closing'); }
          else setPhase('queued');
        } else if (mine?.state === 'succeeded') setPhase('done');
        else if (mine?.state === 'running') setPhase((body.agent.setUp ?? 0) > 0 || body.agent.log.some((l) => /^(Preparing to unpack|Unpacking|Setting up) /.test(l)) ? 'installing' : 'lists');
        else setPhase('queued');
      }
      timer = setTimeout(ask, 2000);
    };
    void ask();
    return () => { stop = true; clearInterval(tick); clearTimeout(timer); };
  }, [task, over]);

  // Finished: the pages behind read the new state; the result stays until it is closed.
  useEffect(() => {
    if (!over) return;
    setEndedAt(Date.now()); setSmall(false);
    window.dispatchEvent(new Event('lvm:host-task-done'));
  }, [over]);
  useEffect(() => { if (task && !small) main.current?.focus(); }, [task, small, over]);
  useEffect(() => {
    if (!task || small) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); if (over) close(); else setSmall(true); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  if (!task) return null;
  function close() {
    try { sessionStorage.removeItem(KEY); } catch { /* storage blocked */ }
    if (phase === 'signin' || (phase === 'done' && task?.kind === 'reboot')) window.location.reload(); else setTask(null);
  }
  const reboot = task.kind === 'reboot';
  const passed = (endedAt ?? now) - task.at;
  const slow = !over && passed > (reboot ? 6 : 30) * 60_000;
  const steps = reboot ? (['queued', 'closing', 'down', 'done'] as const) : (['queued', 'lists', 'installing', 'done'] as const);
  // Where the work stands among the steps ("starting" is the end of "down"; a failure stops at the step it reached).
  const at = phase === 'failed' ? -1 : phase === 'signin' ? steps.length : phase === 'starting' ? 2 : phase === 'done' ? steps.length : (steps as readonly string[]).indexOf(phase);
  const setUp = Math.min(last?.agent.setUp ?? 0, task.n || Infinity);
  const left = closingAt ? Math.max(0, 60 - Math.floor((now - closingAt) / 1000)) : null;
  const detail = (s: string) => {
    if (reboot && s === 'closing' && phase === 'closing') return left ? t('reboot.closingIn', { seconds: left }) : t('reboot.closingNow');
    if (reboot && s === 'down' && phase === 'starting') return t('reboot.starting');
    if (!reboot && s === 'installing' && phase === 'installing' && task.n > 0) return t('install.count', { done: setUp, total: task.n });
    return t(`${reboot ? 'reboot' : 'install'}.help.${s as 'queued'}`);
  };
  const title = phase === 'failed' ? t(reboot ? 'reboot.failedTitle' : 'install.failedTitle') : phase === 'signin' ? t('reboot.signinTitle')
    : phase === 'done' ? t(reboot ? 'reboot.doneTitle' : 'install.doneTitle') : t(reboot ? 'reboot.title' : task.kind === 'security' ? 'install.titleSecurity' : 'install.titleAll');
  const tone = phase === 'failed' ? 'text-danger bg-danger/10' : over ? 'text-success bg-success/10' : 'text-accent bg-accent/10';
  const log = !reboot ? (last?.agent.log ?? []).slice(-6) : [];
  const code = last?.agent.status?.code;

  if (small) return <button type="button" onClick={() => setSmall(false)}
    className="fixed bottom-4 right-4 z-[90] flex min-h-11 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm shadow-lg transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent">
    <I name="loader" size={15} className="animate-spin text-accent motion-reduce:animate-none"/><span>{title}</span><span className="tabular-nums text-muted">{clock(passed)}</span><span className="sr-only">{t('show')}</span>
  </button>;

  return <div className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto bg-background/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="host-task-title">
    <div className="flex w-full max-w-lg flex-col gap-5 rounded-3xl border border-border bg-surface p-6 shadow-2xl">
      <div className="flex items-start gap-3">
        <span className={`flex size-11 shrink-0 items-center justify-center rounded-2xl ${tone}`}>
          {phase === 'failed' ? <I name="circle-x" size={22}/> : over ? <I name="circle-check" size={22}/> : <I name={reboot ? 'rotate-ccw' : 'download'} size={22} className={reboot ? 'animate-spin [animation-direction:reverse] [animation-duration:2.4s] motion-reduce:animate-none' : ''}/>}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="host-task-title" className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted">{over ? t('took', { time: clock(passed) }) : t('passed', { time: clock(passed) })}{!over && <> · {t(reboot ? 'reboot.usual' : 'install.usual')}</>}</p>
        </div>
      </div>

      {!reboot && phase === 'installing' && task.n > 0 && <div role="progressbar" aria-valuemin={0} aria-valuemax={task.n} aria-valuenow={setUp} aria-label={t('install.count', { done: setUp, total: task.n })}
        className="h-2 overflow-hidden rounded-full bg-default"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(4, (setUp / task.n) * 100)}%` }}/></div>}

      <ol className="flex flex-col gap-3" aria-live="polite">
        {steps.map((s, i) => { const done = at > i, active = at === i;
          return <li key={s} className={`flex items-start gap-3 ${done || active ? '' : 'opacity-55'}`} aria-current={active ? 'step' : undefined}>
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
              {done ? <I name="circle-check" size={18} className="text-success"/> : active ? <I name="loader" size={18} className="animate-spin text-accent motion-reduce:animate-none"/> : <I name="circle" size={16} className="text-muted"/>}
            </span>
            <span className="flex min-w-0 flex-col"><span className="text-sm font-medium">{t(`${reboot ? 'reboot' : 'install'}.step.${s}` as 'reboot.step.queued')}</span>
              {(active || (done && s === 'done')) && <span className="text-sm text-muted">{detail(s)}</span>}</span>
          </li>; })}
      </ol>

      {phase === 'failed' && <div role="alert" className="rounded-xl border border-danger/40 bg-danger/5 px-3 py-2 text-sm"><p>{t(reboot ? 'reboot.failed' : 'install.failed')}</p>{code && <p className="mt-1 font-mono text-xs text-muted">{code}</p>}</div>}
      {phase === 'signin' && <p className="rounded-xl border border-border px-3 py-2 text-sm">{t('reboot.signin')}</p>}
      {phase === 'done' && !reboot && last?.os && <p className="rounded-xl border border-border px-3 py-2 text-sm">
        {last.os.total ? t('install.left', { n: last.os.total }) : t('install.none')} {last.os.rebootRequired ? t('install.restartNeeded') : t('install.noRestart')}</p>}
      {!over && silent && !reboot && <p role="status" className="rounded-xl border border-warning/40 bg-warning/5 px-3 py-2 text-sm">{t('install.silent')}</p>}
      {slow && <p role="status" className="rounded-xl border border-warning/40 bg-warning/5 px-3 py-2 text-sm">{t(reboot ? 'reboot.slow' : 'install.slow')}</p>}
      {log.length > 0 && (phase === 'failed' || !over) && <pre aria-label={t('install.log')} className="max-h-32 overflow-auto rounded-xl bg-default/60 p-3 font-mono text-[11px] leading-relaxed text-muted">{log.join('\n')}</pre>}

      {!over && <p className="text-xs text-muted">{t(reboot ? 'reboot.note' : 'install.note')}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {over ? <Button ref={main} onPress={close}>{phase === 'signin' ? t('signinAgain') : t('close')}</Button>
          : <Button ref={main} variant="secondary" onPress={() => setSmall(true)}><I name="minimize-2" size={15}/>{t('aside')}</Button>}
      </div>
    </div>
  </div>;
}
