"use client";
// Usage watch on a server's page: findings of the hourly check that compares the server's CPU and network use with
// its own baseline (GET /servers/:id/anomalies). Each finding says the numbers it rests on and can be hidden; with
// nothing found the block says what was compared, or plainly that there is not enough history (or none on this
// platform) to judge. Nothing here changes the server.
import { Button } from '@heroui/react';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { apiFetch } from '../lib/api';
import { useApiAction, useApiQuery } from '../lib/query';
import { I } from './icon';
import { Section } from './ui';

export type AnomalyDetail = { recent?: number; value?: number; usual?: number; baseline?: number; days?: number; day?: string; outShare?: number | null; hint?: 'cpu_pinned' | 'outbound' | null };
export type Anomaly = { id: string; metric: 'cpu' | 'network'; direction: 'high' | 'low'; openedAt: string; lastSeen: string; detail: AnomalyDetail };
type Watch = { measured: boolean; days: number; minDays: number; enough: boolean; anomalies: Anomaly[]; hidden: number };

// Traffic in GB with one decimal, as the notice and the insight write it.
export const gigabytes = (bytes: number | undefined) => Math.round((bytes ?? 0) / 1e8) / 10;

export function ServerAnomalies({ id }: { id: string }) {
  const t = useTranslations('Anomalies');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const q = useApiQuery<Watch>(['servers', id, 'anomalies'], `/servers/${id}/anomalies`, { refetchInterval: 300_000 });
  const hide = useApiAction((a: Anomaly) => apiFetch('/insights/dismissals', { method: 'PUT', body: { key: `anomaly:${a.id}`, days: 7 } }),
    { invalidate: [['servers', id, 'anomalies'], ['insights']], success: t('hidden') });
  const d = q.data;
  if (!d) return null;
  return <Section title={t('title')} description={t('help')}>
    <div className="flex flex-col gap-3">
      {d.anomalies.map((a) => {
        const kind = `${a.metric}.${a.direction}` as 'cpu.high';
        const up = a.direction === 'high';
        const numbers = a.metric === 'cpu'
          ? t('cpuNumbers', { recent: Math.round(a.detail.recent ?? 0), usual: Math.round(a.detail.usual ?? 0), hours: a.detail.baseline ?? 0, days: a.detail.days ?? 0 })
          : t('networkNumbers', { recent: gigabytes(a.detail.value), usual: gigabytes(a.detail.usual), days: a.detail.baseline ?? 0, out: Math.round((a.detail.outShare ?? 0) * 100) });
        return <div key={a.id} className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${a.direction === 'high' ? 'border-warning/40 bg-warning/5' : 'border-border bg-default/40'}`}>
          <span className={`mt-0.5 shrink-0 ${a.direction === 'high' ? 'text-warning' : 'text-accent'}`}><I name={up ? 'trending-up' : 'trending-down'} size={18}/></span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t(`kind.${kind}`)}</p>
            <p className="text-sm text-muted [overflow-wrap:anywhere]">{numbers}</p>
            <p className="mt-1 text-xs text-muted">{t('since', { when: format.relativeTime(new Date(Math.min(Date.parse(a.openedAt), now.getTime())), now) })} · {t(`advice.${kind}`)}</p>
          </div>
          <Button size="sm" variant="ghost" className="shrink-0" isPending={hide.isPending && hide.variables?.id === a.id} onPress={() => hide.mutate(a)} aria-label={t('hideLabel', { what: t(`kind.${kind}`) })}>
            <I name="eye-off" size={16}/>{t('hide')}
          </Button>
        </div>;
      })}
      {d.anomalies.length === 0 && <p className="flex items-start gap-2 text-sm text-muted">
        <I name={d.enough ? 'circle-check' : 'info'} size={16} className={`mt-0.5 shrink-0 ${d.enough ? 'text-success' : ''}`}/>
        <span>{!d.measured ? t('notMeasured') : !d.enough ? t('notEnough', { days: d.days, min: d.minDays }) : t('normal', { days: d.days })}</span>
      </p>}
      {d.hidden > 0 && <p className="text-xs text-muted">{t('hiddenCount', { n: d.hidden })}</p>}
    </div>
  </Section>;
}
