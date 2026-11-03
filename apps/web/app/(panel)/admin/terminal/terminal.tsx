"use client";
// The administrators' browser terminal to this host. Off by default: turning it on asks the host agent to start
// the terminal service. Connecting gets a one-time cookie from the API and opens wss://<panel>/terminal/ws;
// keystrokes go as binary frames, window size as {"type":"resize"} text frames. Input is not recorded; opening
// and closing are audited.
import '@xterm/xterm/css/xterm.css';
import { Button, Card, Tooltip, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import NextLink from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { I } from '../../../../components/icon';
import { ConfirmButton, Notice, PageHeader, Section, StatusChip } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { ConsoleSnippets } from '../../../../components/console-snippets';
import { useApiQuery } from '../../../../lib/query';

type Status = { enabled: boolean; agent: boolean; twoFactor: boolean; switching: boolean; sessions: { key: string; email: string | null; startedAt: string }[] };
const fontKey = 'lvm.terminalFont';
const minFont = 10, maxFont = 24;
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
  const typeIn = useRef<(text: string) => void>(undefined);
  const xterm = useRef<import('@xterm/xterm').Terminal>(undefined);
  const frame = useRef<HTMLDivElement>(null);
  const refit = useRef<() => void>(undefined);
  const [fontSize, setFontSize] = useState(14);
  const [full, setFull] = useState(false);
  useEffect(() => { if (s?.enabled && waiting) setWaiting(false); }, [s?.enabled, waiting]);
  useEffect(() => () => cleanup.current?.(), []);
  // The font size is a per-browser convenience.
  useEffect(() => { try { const v = Number(localStorage.getItem(fontKey)); if (v >= minFont && v <= maxFont) setFontSize(v); } catch { /* storage blocked */ } }, []);
  useEffect(() => { if (xterm.current) { xterm.current.options.fontSize = fontSize; refit.current?.(); } try { localStorage.setItem(fontKey, String(fontSize)); } catch { /* storage blocked */ } }, [fontSize]);
  useEffect(() => { const f = () => setFull(document.fullscreenElement === frame.current); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); }, []);

  // The selection, or the whole buffer (scrollback included) when nothing is selected.
  async function copy() {
    const term = xterm.current;
    if (!term) return;
    let text = term.getSelection();
    const all = !text;
    if (all) {
      const b = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
      text = lines.join('\n').replace(/\s+$/, '');
    }
    try { await navigator.clipboard.writeText(text); toast.success(all ? t('copiedAll') : t('copied')); }
    catch { toast.danger(t('clipboardBlocked')); }
    term.focus();
  }
  async function paste() {
    try { const text = await navigator.clipboard.readText(); if (text) xterm.current?.paste(text); }
    catch { toast.danger(t('clipboardBlocked')); }
    xterm.current?.focus();
  }
  // Empties the scrollback here, then Ctrl+L so the shell redraws its prompt on a clean screen.
  function clear() {
    xterm.current?.clear();
    typeIn.current?.('\x0c');
  }
  function fullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frame.current?.requestFullscreen().catch(() => undefined);
  }

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
    const term = new XTerm({ cursorBlink: true, fontSize, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', scrollback: 10000,
      rightClickSelectsWord: true, macOptionIsMeta: true,
      theme: { background: '#0b0f17', foreground: '#e5e7eb', cursor: '#f59e0b', cursorAccent: '#0b0f17', selectionBackground: '#475569',
        black: '#1f2937', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e5e7eb',
        brightBlack: '#6b7280', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#f9fafb' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Terminal shortcuts: Ctrl+Shift+C copies, Ctrl+Shift+V pastes; Ctrl+C copies while text is selected, else it
    // is the shell's interrupt.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
      const k = e.key.toLowerCase();
      if (k === 'c' && (e.shiftKey || term.hasSelection())) { e.preventDefault(); void copy(); return false; }
      if (k === 'v' && e.shiftKey) return false;   // the browser's paste event reaches xterm by itself
      return true;
    });
    box.current!.innerHTML = '';
    term.open(box.current!);
    xterm.current = term;
    fit.fit();
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/terminal/ws`);
    ws.binaryType = 'arraybuffer';
    const enc = new TextEncoder();
    const size = () => { try { fit.fit(); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch { /* closed */ } };
    ws.onopen = () => { setState('open'); size(); term.focus(); };
    ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = (e) => { setState('closed'); setReason(reasons.includes(e.reason) ? t(`reason.${e.reason as 'TERMINAL_CLOSED'}`) : t('reason.TERMINAL_CLOSED')); client.invalidateQueries({ queryKey: ['admin', 'terminal'] }); };
    const input = term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d)); });
    // A shell reads Enter as a carriage return, as the keyboard sends it.
    typeIn.current = (text) => { if (ws.readyState === WebSocket.OPEN) { ws.send(enc.encode(text.replace(/\n/g, '\r'))); term.focus(); } };
    refit.current = size;
    const observer = new ResizeObserver(size);
    observer.observe(box.current!);
    cleanup.current = () => { observer.disconnect(); input.dispose(); ws.close(); term.dispose(); xterm.current = undefined; };
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
      <motion.div ref={frame} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className={`flex flex-col overflow-hidden border-border bg-[#0b0f17] shadow-lg ${full ? '' : 'rounded-2xl border'}`}>
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 text-xs text-slate-300">
          <span className="flex gap-1.5" aria-hidden><span className="size-3 rounded-full bg-red-500/80"/><span className="size-3 rounded-full bg-amber-400/80"/><span className="size-3 rounded-full bg-emerald-500/80"/></span>
          <span className="ml-2 font-mono">root@{typeof location !== 'undefined' ? location.hostname : 'host'}</span>
          <span className="ml-auto flex flex-wrap items-center gap-1">
            {state === 'open' && <>
              <TermTool label={t('copy')} onPress={copy}><I name="copy" size={15}/></TermTool>
              <TermTool label={t('paste')} onPress={paste}><I name="clipboard-paste" size={15}/></TermTool>
              <TermTool label={t('clear')} onPress={clear}><I name="eraser" size={15}/></TermTool>
              <span className="mx-1 h-5 w-px bg-white/10" aria-hidden/>
              <TermTool label={t('fontSmaller')} isDisabled={fontSize <= minFont} onPress={() => setFontSize((v) => Math.max(minFont, v - 1))}><I name="a-arrow-down" size={15}/></TermTool>
              <TermTool label={t('fontLarger')} isDisabled={fontSize >= maxFont} onPress={() => setFontSize((v) => Math.min(maxFont, v + 1))}><I name="a-arrow-up" size={15}/></TermTool>
            </>}
            <TermTool label={full ? t('exitFullscreen') : t('fullscreen')} onPress={fullscreen}><I name={full ? 'minimize' : 'maximize'} size={15}/></TermTool>
            {state === 'open' ? <Button size="sm" variant="secondary" className="ml-1" onPress={() => { cleanup.current?.(); setState('closed'); setReason(t('reason.TERMINAL_CLOSED')); }}><I name="unplug" size={14}/>{t('disconnect')}</Button>
              : <Button size="sm" className="ml-1" isPending={state === 'connecting'} onPress={connect}><I name="plug-zap" size={14}/>{state === 'closed' ? t('reconnect') : t('connect')}</Button>}
          </span>
        </div>
        <div className={`relative p-2 ${full ? 'min-h-0 flex-1' : 'h-[65vh] min-h-72'}`}>
          <div ref={box} className="h-full w-full" aria-label={t('title')}/>
          {state !== 'open' && state !== 'connecting' && <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-slate-300">
            <div className="flex max-w-sm flex-col items-center gap-3">
              <I name="square-terminal" size={32} className="text-amber-400"/>
              <p>{reason ?? t('ready')}</p>
              <Button onPress={connect}><I name="plug-zap" size={16}/>{state === 'closed' ? t('reconnect') : t('connect')}</Button>
            </div>
          </div>}
        </div>
        {state === 'open' && <p className="border-t border-white/10 px-3 py-1.5 text-[11px] text-slate-400">{t('shortcuts')}</p>}
      </motion.div>
      <ConsoleSnippets linuxOnly ready={state === 'open'} send={(text) => typeIn.current?.(text)}/>
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

// Icon button in the terminal's title bar; the label is its accessible name and tooltip.
function TermTool({ label, onPress, isDisabled, children }: { label: string; onPress: () => void; isDisabled?: boolean; children: React.ReactNode }) {
  return <Tooltip delay={400}>
    <Button size="sm" variant="ghost" isIconOnly aria-label={label} isDisabled={isDisabled} onPress={onPress}
      className="min-h-8 min-w-8 text-slate-300 hover:bg-white/10 hover:text-white">{children}</Button>
    <Tooltip.Content>{label}</Tooltip.Content>
  </Tooltip>;
}
