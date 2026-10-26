"use client";
// The administrators' browser terminal to this host. Off by default: turning it on asks the host agent to start
// the terminal service. Connecting gets a one-time cookie from the API and opens wss://<panel>/terminal/ws;
// keystrokes go as binary frames, window size as {"type":"resize"} text frames. Input is not recorded; opening
// and closing are audited.
import '@xterm/xterm/css/xterm.css';
import { Button, Card, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import NextLink from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { I } from '../../../../components/icon';
import { ConfirmButton, Notice, PageHeader, Section, StatusChip } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Status = { enabled: boolean; agent: boolean; twoFactor: boolean; switching: boolean; sessions: { key: string; email: string | null; startedAt: string }[] };
const reasons = ['TERMINAL_SESSION_INVALID', 'TERMINAL_REVOKED', 'TERMINAL_EXPIRED', 'TERMINAL_IDLE', 'TERMINAL_LIMIT', 'TERMINAL_START_FAILED', 'TERMINAL_CLOSED'];

export default function Terminal() {
  const t = useTranslations('Terminal');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const [waiting, setWaiting] = useState(false);
  const q = useApiQuery<Status>(['admin', 'terminal'], '/admin/terminal', { refetchInterval: waiting ? 4_000 : 30_000 });
  const s = q.data;
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'idle' | 'connecting' | 'open' | 'closed'>('idle');
  const [reason, setReason] = useState<string>();
  const cleanup = useRef<() => void>(undefined);
  useEffect(() => { if (s?.enabled && waiting) setWaiting(false); }, [s?.enabled, waiting]);
  useEffect(() => () => cleanup.current?.(), []);

  async function switchTo(enabled: boolean) {
    try { await apiFetch('/admin/terminal/switch', { method: 'POST', body: { enabled } }); setWaiting(true); toast.success(enabled ? t('starting') : t('stopping')); }
    catch (e) { toast.danger(error(e)); }
    client.invalidateQueries({ queryKey: ['admin', 'terminal'] });
  }

  async function connect() {
    cleanup.current?.();
    setState('connecting'); setReason(undefined);
    try { await apiFetch('/admin/terminal/session', { method: 'POST' }); }
    catch (e) { setState('closed'); setReason(error(e)); return; }
    const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
    const term = new XTerm({ cursorBlink: true, fontSize: 14, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', scrollback: 5000,
      theme: { background: '#0b0f17', foreground: '#e5e7eb', cursor: '#f59e0b', selectionBackground: '#334155' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    box.current!.innerHTML = '';
    term.open(box.current!);
    fit.fit();
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/terminal/ws`);
    ws.binaryType = 'arraybuffer';
    const enc = new TextEncoder();
    const size = () => { try { fit.fit(); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch { /* closed */ } };
    ws.onopen = () => { setState('open'); size(); term.focus(); };
    ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = (e) => { setState('closed'); setReason(reasons.includes(e.reason) ? t(`reason.${e.reason as 'TERMINAL_CLOSED'}`) : t('reason.TERMINAL_CLOSED')); client.invalidateQueries({ queryKey: ['admin', 'terminal'] }); };
    const input = term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d)); });
    const observer = new ResizeObserver(size);
    observer.observe(box.current!);
    cleanup.current = () => { observer.disconnect(); input.dispose(); ws.close(); term.dispose(); };
  }

  return <div className="flex flex-col gap-6">
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')}
      actions={s?.enabled && <StatusChip tone={state === 'open' ? 'success' : 'default'}>{t(`state.${state}`)}</StatusChip>}/>
    {q.error && !s ? <Notice tone="danger">{error(q.error)}</Notice>
    : !s ? <Card className="h-40 animate-pulse"><span className="sr-only">…</span></Card>
    : !s.twoFactor ? <Notice tone="warning" title={t('needs2faTitle')}>{t('needs2fa')} <NextLink href="/account?tab=security" className="font-medium underline">{t('to2fa')}</NextLink></Notice>
    : !s.enabled ? <Section title={t('offTitle')} description={t('offHelp')}>
        <div className="flex flex-col gap-4">
          {!s.agent && <Notice tone="warning">{t('noAgent')}</Notice>}
          {(waiting || s.switching) && <p role="status" className="flex items-center gap-2 text-sm text-accent"><I name="loader-circle" size={16} className="animate-spin motion-reduce:animate-none"/>{t('startingHelp')}</p>}
          <div><Button isDisabled={!s.agent || waiting || s.switching} isPending={waiting || s.switching} onPress={() => switchTo(true)}><I name="power" size={16}/>{t('turnOn')}</Button></div>
        </div>
      </Section>
    : <>
      <Notice tone="warning" title={t('rootTitle')}>{t('root')}</Notice>
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="overflow-hidden rounded-2xl border border-border bg-[#0b0f17] shadow-lg">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 text-xs text-slate-300">
          <span className="flex gap-1.5" aria-hidden><span className="size-3 rounded-full bg-red-500/80"/><span className="size-3 rounded-full bg-amber-400/80"/><span className="size-3 rounded-full bg-emerald-500/80"/></span>
          <span className="ml-2 font-mono">root@{typeof location !== 'undefined' ? location.hostname : 'host'}</span>
          <span className="ml-auto flex gap-2">
            {state === 'open' ? <Button size="sm" variant="secondary" onPress={() => { cleanup.current?.(); setState('closed'); setReason(t('reason.TERMINAL_CLOSED')); }}><I name="unplug" size={14}/>{t('disconnect')}</Button>
              : <Button size="sm" isPending={state === 'connecting'} onPress={connect}><I name="plug-zap" size={14}/>{state === 'closed' ? t('reconnect') : t('connect')}</Button>}
          </span>
        </div>
        <div className="relative h-[60vh] min-h-72 p-2">
          <div ref={box} className="h-full w-full" aria-label={t('title')}/>
          {state !== 'open' && state !== 'connecting' && <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-slate-300">
            <div className="flex max-w-sm flex-col items-center gap-3">
              <I name="square-terminal" size={32} className="text-amber-400"/>
              <p>{reason ?? t('ready')}</p>
              <Button onPress={connect}><I name="plug-zap" size={16}/>{state === 'closed' ? t('reconnect') : t('connect')}</Button>
            </div>
          </div>}
        </div>
      </motion.div>
      <Section title={t('sessions')} description={t('sessionsHelp')}
        actions={<ConfirmButton size="sm" variant="danger-soft" icon={<I name="power-off" size={15}/>} label={t('turnOff')} title={t('turnOff')} body={t('turnOffBody')}
          confirmLabel={t('turnOffYes')} cancelLabel={t('cancel')} onConfirm={() => switchTo(false)}/>}>
        {s.sessions.length === 0 ? <p className="text-sm text-muted">{t('noSessions')}</p>
        : <ul className="flex flex-col divide-y divide-separator">{s.sessions.map((x) => <li key={x.key} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <I name="user" size={14} className="text-muted"/><span className="font-medium">{x.email ?? '–'}</span>
            <span className="text-xs text-muted">{format.relativeTime(new Date(x.startedAt))}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onPress={async () => { await apiFetch(`/admin/terminal/sessions/${x.key}/revoke`, { method: 'POST' }); client.invalidateQueries({ queryKey: ['admin', 'terminal'] }); }}>
              <I name="x" size={14}/>{t('end')}</Button>
          </li>)}</ul>}
      </Section>
    </>}
  </div>;
}
