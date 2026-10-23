"use client";
import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { apiFetch, useErrorText } from '../../../lib/api';

type Worker = { healthy: boolean; last_seen: string };
type State = { phase: 'checking' } | { phase: 'ok'; worker?: Worker } | { phase: 'error'; error: unknown };

export default function Status() {
  const t = useTranslations('Status');
  const { error } = useErrorText();
  const format = useFormatter();
  const [state, setState] = useState<State>({ phase: 'checking' });
  useEffect(() => { let active = true; const controller = new AbortController();
    async function load() { try {
      await apiFetch('/ready', { signal: controller.signal });
      const data = await apiFetch<{ worker: Worker[] }>('/admin/system', { signal: controller.signal });
      if (active) setState({ phase: 'ok', worker: data.worker.find(w => w.healthy) });
    } catch (e) { if (active) setState({ phase: 'error', error: e }); } }
    load(); const timer = setInterval(load, 15000); return () => { active = false; controller.abort(); clearInterval(timer); }; }, []);

  const worker = state.phase === 'checking' ? t('workerWaiting')
    : state.phase === 'error' ? t('workerUnknown')
    : state.worker ? t('workerRunning', { time: format.dateTime(new Date(state.worker.last_seen), { dateStyle: 'medium', timeStyle: 'medium' }) })
    : t('workerNoHeartbeat');
  return <article><h2>{t('title')}</h2>
    <p role="status">{state.phase === 'checking' ? t('checking') : state.phase === 'ok' ? t('reachable') : error(state.error)}</p>
    <p>{t('worker', { state: worker })}</p><small>{t('disclaimer')}</small></article>;
}
