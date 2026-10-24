"use client";
import { useFormatter, useTranslations } from 'next-intl';
import { Section, StatusChip } from '../../../components/ui';
import { useErrorText } from '../../../lib/api';
import { useApiQuery } from '../../../lib/query';

type Worker = { healthy: boolean; last_seen: string };

export default function Status() {
  const t = useTranslations('Status');
  const { error } = useErrorText();
  const format = useFormatter();
  const ready = useApiQuery(['ready'], '/ready', { refetchInterval: 15_000 });
  const system = useApiQuery<{ worker: Worker[] }>(['admin', 'system'], '/admin/system', { refetchInterval: 15_000 });
  const worker = system.data?.worker.find((w) => w.healthy);
  const health = ready.isPending ? t('checking') : ready.isError ? error(ready.error) : t('reachable');
  const workerText = system.isPending ? t('workerWaiting') : system.isError ? t('workerUnknown')
    : worker ? t('workerRunning', { time: format.dateTime(new Date(worker.last_seen), { dateStyle: 'medium', timeStyle: 'medium' }) }) : t('workerNoHeartbeat');
  return <Section title={t('title')} description={t('disclaimer')}>
    <ul className="flex flex-col gap-3 text-sm">
      <li className="flex flex-wrap items-center gap-2">
        <StatusChip tone={ready.isPending ? 'default' : ready.isError ? 'danger' : 'success'}>{ready.isError ? '!' : 'API'}</StatusChip>
        <span role="status" data-testid="health">{health}</span>
      </li>
      <li className="flex flex-wrap items-center gap-2">
        <StatusChip tone={worker ? 'success' : system.isPending ? 'default' : 'warning'}>Worker</StatusChip>
        <span>{t('worker', { state: workerText })}</span>
      </li>
    </ul>
  </Section>;
}
