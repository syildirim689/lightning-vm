"use client";
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { Section, StatusChip } from '../../../components/ui';
import { useErrorText } from '../../../lib/api';
import { useApiQuery } from '../../../lib/query';

type Worker = { healthy: boolean; last_seen: string };

export default function Status() {
  const t = useTranslations('Status');
  const { error } = useErrorText();
  const format = useFormatter();
  const now = useNow({ updateInterval: 10_000 });
  const ready = useApiQuery(['ready'], '/ready', { refetchInterval: 15_000 });
  const system = useApiQuery<{ worker: Worker[] }>(['admin', 'system'], '/admin/system', { refetchInterval: 15_000 });
  const worker = system.data?.worker.find((w) => w.healthy);
  // The worker beats about every 10 seconds; two minutes of silence means it is stuck or restarting.
  const stale = !!worker && now.getTime() - Date.parse(worker.last_seen) > 120_000;
  const health = ready.isPending ? t('checking') : ready.isError ? error(ready.error) : t('reachable');
  const workerText = system.isPending ? t('workerWaiting') : system.isError ? t('workerUnknown')
    : worker ? t(stale ? 'workerStale' : 'workerRunning', { time: format.relativeTime(new Date(Math.min(Date.parse(worker.last_seen), now.getTime())), now) }) : t('workerNoHeartbeat');
  return <Section title={t('title')} description={t('disclaimer')}>
    <ul className="flex flex-col gap-3 text-sm">
      <li className="flex flex-wrap items-center gap-2">
        <StatusChip tone={ready.isPending ? 'default' : ready.isError ? 'danger' : 'success'}>{ready.isError ? '!' : 'API'}</StatusChip>
        <span role="status" data-testid="health">{health}</span>
      </li>
      <li className="flex flex-wrap items-center gap-2">
        <StatusChip tone={worker && !stale ? 'success' : system.isPending ? 'default' : 'warning'}>Worker</StatusChip>
        <span title={worker ? format.dateTime(new Date(worker.last_seen), { dateStyle: 'medium', timeStyle: 'medium' }) : undefined}>{t('worker', { state: workerText })}</span>
      </li>
    </ul>
  </Section>;
}
