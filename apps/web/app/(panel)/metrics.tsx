"use client";
// Live performance of one server from VMware (20-second samples, refreshed while visible). Each chart also
// states its current value in text, and refreshing can be paused.
import { Button, Card } from '@heroui/react';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { I } from '../../components/icon';
import { Section } from '../../components/ui';
import { useErrorText } from '../../lib/api';
import { useApiQuery } from '../../lib/query';

type Sample = { t: string; cpu: number | null; mem: number | null; net: number | null; disk: number | null };
type Metrics = { interval: number; samples: Sample[]; quick: Record<string, number>; vcpu: number; memoryMb: number; fetchedAt: string };
const tooltip = { background: 'var(--overlay)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--overlay-foreground)', fontSize: 12 };

export default function ServerMetrics({ id, live }: { id: string; live: boolean }) {
  const t = useTranslations('Metrics');
  const format = useFormatter();
  const { error } = useErrorText();
  const [paused, setPaused] = useState(false);
  const q = useApiQuery<Metrics>(['metrics', id], live ? `/servers/${id}/metrics` : null, { refetchInterval: paused ? false : 20_000 });
  const data = (q.data?.samples ?? []).map((s) => ({ ...s, time: format.dateTime(new Date(s.t), { timeStyle: 'short' }) }));
  const last = data.at(-1);
  const kb = (v: number | null | undefined) => v == null ? '–' : v >= 1024 ? `${format.number(v / 1024, { maximumFractionDigits: 1 })} MB/s` : `${format.number(v, { maximumFractionDigits: 0 })} KB/s`;
  const pct = (v: number | null | undefined) => v == null ? '–' : `%${format.number(v, { maximumFractionDigits: 1 })}`;
  const charts = [
    { key: 'cpu' as const, label: t('cpu'), value: pct(last?.cpu), color: 'var(--accent)', domain: [0, 100] as [number, number], fmt: pct },
    { key: 'mem' as const, label: t('memory'), value: pct(last?.mem), color: 'var(--success)', domain: [0, 100] as [number, number], fmt: pct },
    { key: 'net' as const, label: t('network'), value: kb(last?.net), color: 'var(--warning)', domain: [0, 'auto'] as unknown as [number, number], fmt: kb },
    { key: 'disk' as const, label: t('disk'), value: kb(last?.disk), color: 'oklch(0.65 0.15 250)', domain: [0, 'auto'] as unknown as [number, number], fmt: kb },
  ];
  const uptime = q.data?.quick.uptimeSeconds;
  return <Section title={t('title')} description={live ? t('intro') : t('offline')}
    actions={live && <Button size="sm" variant="ghost" onPress={() => setPaused((p) => !p)} aria-pressed={paused}>{paused ? <I name="play" size={15}/> : <I name="pause" size={15}/>}{paused ? t('resume') : t('pause')}</Button>}>
    {!live ? <p className="text-sm text-muted">{t('offlineHelp')}</p>
      : q.error ? <p role="alert" className="text-sm text-danger">{error(q.error)}</p>
      : !q.data ? <div className="grid gap-3 sm:grid-cols-2" aria-busy>{[0, 1, 2, 3].map((i) => <div key={i} className="h-36 animate-pulse rounded-xl bg-default/50"/>)}</div>
      : data.length === 0 ? <p className="text-sm text-muted">{t('noSamples')}</p>
      : <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">{charts.map((c) => <Card key={c.key} variant="secondary" className="overflow-hidden">
            <Card.Content className="flex flex-col gap-1 p-3">
              <div className="flex items-baseline justify-between"><span className="text-xs font-medium uppercase tracking-wider text-muted">{c.label}</span>
                <span className="text-lg font-semibold tabular-nums" aria-live="polite">{c.value}</span></div>
              <div className="h-24" role="img" aria-label={`${c.label}: ${c.value}`}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data} margin={{ top: 4, left: 0, right: 0, bottom: 0 }}>
                    <defs><linearGradient id={`g-${c.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c.color} stopOpacity={0.35}/><stop offset="100%" stopColor={c.color} stopOpacity={0}/></linearGradient></defs>
                    <XAxis dataKey="time" hide/><YAxis hide domain={c.domain}/>
                    <Tooltip contentStyle={tooltip} formatter={(v) => c.fmt(Number(v))} labelFormatter={(l) => String(l)}/>
                    <Area type="monotone" dataKey={c.key} stroke={c.color} strokeWidth={2} fill={`url(#g-${c.key})`} isAnimationActive={false} connectNulls/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card.Content>
          </Card>)}</div>
          <p className="text-xs text-muted">{t('footer', { n: data.length, interval: q.data.interval })}{uptime ? ` · ${t('uptime', { h: Math.floor(uptime / 3600), m: Math.floor((uptime % 3600) / 60) })}` : ''}</p>
        </div>}
  </Section>;
}
