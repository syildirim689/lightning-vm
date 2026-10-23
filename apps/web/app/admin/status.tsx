"use client";
import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

type Worker = { healthy: boolean; last_seen: string };
type State = { phase: 'checking' } | { phase: 'ok'; worker?: Worker } | { phase: 'error'; code: string };

// API errors carry a stable `code`; the UI translates it, never the raw message.
async function getJson(url: string, signal: AbortSignal) {
  const res = await fetch(url, { signal }).catch(e => { throw signal.aborted ? e : { code: 'NETWORK' }; });
  if (!res.ok) throw { code: (await res.json().catch(() => null))?.code ?? 'UNKNOWN' };
  return res.json();
}

export default function Status() {
  const t = useTranslations('Status');
  const te = useTranslations('errors');
  const format = useFormatter();
  const [state, setState] = useState<State>({ phase: 'checking' });
  useEffect(() => { let active = true; const controller = new AbortController();
    async function load() { try {
      await getJson('/api/ready', controller.signal);
      const data = await getJson('/api/system', controller.signal);
      if (active) setState({ phase: 'ok', worker: (data.worker as Worker[]).find(w => w.healthy) });
    } catch (e) { if (active) setState({ phase: 'error', code: (e as { code?: string }).code ?? 'UNKNOWN' }); } }
    load(); const timer = setInterval(load, 15000); return () => { active = false; controller.abort(); clearInterval(timer); }; }, []);

  const errorText = (code: string) => te.has(code as 'UNKNOWN') ? te(code as 'UNKNOWN') : te('UNKNOWN');
  const worker = state.phase === 'checking' ? t('workerWaiting')
    : state.phase === 'error' ? t('workerUnknown')
    : state.worker ? t('workerRunning', { time: format.dateTime(new Date(state.worker.last_seen), { dateStyle: 'medium', timeStyle: 'medium' }) })
    : t('workerNoHeartbeat');
  return <article><h2>{t('title')}</h2>
    <p role="status">{state.phase === 'checking' ? t('checking') : state.phase === 'ok' ? t('reachable') : errorText(state.code)}</p>
    <p>{t('worker', { state: worker })}</p><small>{t('disclaimer')}</small></article>;
}
