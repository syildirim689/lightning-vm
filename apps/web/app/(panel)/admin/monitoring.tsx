"use client";
// Monitoring after installation (Admin → System): whether Prometheus, Grafana and Loki answer right now, and a switch
// that turns the monitoring components on or off. The API only drops a request for the host agent, as it does for a
// backup or an update (the same permission, one task at a time); the agent runs `install.sh monitoring on|off`, which
// touches only those components. The page keeps asking while the agent works.
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../components/icon';
import { ConfirmButton, Mono, Notice, Section, StatusChip, type Tone } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { useMe } from '../../../lib/me';
import { can } from '../../../lib/permissions';
import { useApiQuery } from '../../../lib/query';

type Check = { id: string; ok: boolean; code: string };
type Run = { id: string; action: string; state: 'running' | 'succeeded' | 'failed' | 'rejected'; startedAt: string; finishedAt: string; code: string };
type Data = { state: 'on' | 'off' | 'partial'; checks: Check[]; agent: { installed: boolean; pending: number; busy: boolean; status: Run | null; log: string[] } };
const stateTone: Record<Data['state'], Tone> = { on: 'success', off: 'default', partial: 'warning' };
const names: Record<string, string> = { prometheus: 'Prometheus', grafana: 'Grafana', loki: 'Loki' };

export default function Monitoring() {
  const t = useTranslations('MonitoringSwitch');
  const tc = useTranslations('Setup');
  const { error, code: codeText } = useErrorText();
  const me = useMe();
  const client = useQueryClient();
  const manage = can(me?.permissions, 'system.update');
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false); // this page queued a switch the agent has not finished yet
  const q = useApiQuery<Data>(['admin', 'monitoring'], '/admin/maintenance/monitoring', { refetchInterval: watching ? 3_000 : 30_000 });
  const data = q.data;
  // While the agent has a task queued or running the state is read every few seconds; a switch that just ended is
  // read a little longer (Loki needs about a minute before it answers).
  useEffect(() => {
    if (!data) return;
    setWatching(data.agent.busy || (data.state === 'partial' && data.agent.status?.state === 'succeeded'));
    if (!data.agent.busy) setAsked(false);
  }, [data]);

  if (!data) return <Section title={t('title')}><p role="status" className="text-sm text-muted">{q.error ? error(q.error) : t('loading')}</p></Section>;
  const run = data.agent.status;
  // A switch is under way when the agent runs one, or when the one asked for here still waits for it. Any other
  // queued or running task (a backup, an update, the check for system updates) only blocks the buttons.
  const switching = data.agent.busy && (run?.state === 'running' || asked);
  async function ask(enabled: boolean) {
    setBusy(true);
    try {
      await apiFetch('/admin/maintenance/requests', { method: 'POST', body: { action: 'monitoring', enabled } });
      toast.success(t(enabled ? 'onQueued' : 'offQueued')); setWatching(true); setAsked(true);
      for (const queryKey of [['admin', 'monitoring'], ['admin', 'maintenance']]) void client.invalidateQueries({ queryKey });
    } catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  const blocked = !manage || !data.agent.installed || data.agent.busy || busy;
  const reason = (c: Check) => (tc.has(`checkCodes.${c.code}` as 'checkCodes.OK') ? tc(`checkCodes.${c.code}` as 'checkCodes.OK') : c.code);
  return <Section title={t('title')} description={t('intro')}>
    <div className="flex flex-col gap-4" data-testid="monitoring-switch">
      <div className="flex flex-wrap items-center gap-3">
        <StatusChip tone={switching ? 'accent' : stateTone[data.state]}>{switching ? t('state.switching') : t(`state.${data.state}`)}</StatusChip>
        <span className="text-sm text-muted">{t(`stateHelp.${data.state}`)}</span>
      </div>
      <ul aria-label={t('components')} className="grid gap-2 text-sm sm:grid-cols-3">
        {data.checks.map((c) => <li key={c.id} className="flex min-w-0 items-start gap-2 rounded-lg bg-default/60 p-3">
          <I name={c.ok ? 'circle-check' : 'circle-x'} size={16} className={`mt-0.5 shrink-0 ${c.ok ? 'text-success' : 'text-muted'}`}/>
          <span className="min-w-0"><span className="block font-medium">{names[c.id] ?? c.id}</span>
            <span className="block text-xs text-muted [overflow-wrap:anywhere]">{c.ok ? t('answers') : t('noAnswer', { reason: reason(c) })}</span></span>
        </li>)}
      </ul>
      {!data.agent.installed && <Notice tone="warning" title={t('agentMissingTitle')}>{t('agentMissing')} <Mono>sudo sh scripts/install.sh agent on</Mono></Notice>}
      {data.agent.installed && data.agent.busy && !switching && <Notice tone="default">{t('otherTask')}</Notice>}
      {run && (run.state === 'failed' || run.state === 'rejected') && <Notice tone="danger" title={t('lastFailed', { code: run.code ? codeText(run.code) : run.state })}>
        {data.agent.log.length > 0 && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">{data.agent.log.slice(-6).join('\n')}</pre>}</Notice>}
      {switching && data.agent.log.length > 0 && <pre aria-label={t('progress')} className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-default p-3 font-mono text-xs [overflow-wrap:anywhere]">{data.agent.log.slice(-6).join('\n')}</pre>}
      {manage ? <div className="flex flex-wrap gap-2">
        {data.state !== 'on' && <ConfirmButton size="sm" variant="primary" icon={<I name="play" size={14}/>} label={t('turnOn')} isDisabled={blocked}
          title={t('onTitle')} body={t('onBody')} confirmLabel={t('turnOn')} cancelLabel={t('cancel')} onConfirm={() => ask(true)}/>}
        {data.state !== 'off' && <ConfirmButton size="sm" variant="danger-soft" icon={<I name="power" size={14}/>} label={t('turnOff')} isDisabled={blocked}
          title={t('offTitle')} body={t('offBody')} confirmLabel={t('turnOff')} cancelLabel={t('cancel')} onConfirm={() => ask(false)}/>}
        <Button size="sm" variant="ghost" isDisabled={q.isFetching} onPress={() => void q.refetch()}><I name="refresh-cw" size={14}/>{t('refresh')}</Button>
      </div> : <p className="text-sm text-muted">{t('needsPermission')}</p>}
    </div>
  </Section>;
}
