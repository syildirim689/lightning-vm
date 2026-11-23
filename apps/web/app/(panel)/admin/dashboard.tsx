"use client";
import { Button, Card, ProgressBar } from '@heroui/react';
import NextLink from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { I } from '../../../components/icon';
import CountUp from '../../../components/count-up';
import Insights from '../../../components/insights';
import Digest from '../../../components/digest';
import OnlineNow from '../../../components/online-now';
import { DataTable, Notice, PageHeader, Section, Stat, StatusChip } from '../../../components/ui';
import { useApiQuery } from '../../../lib/query';
import { useErrorText } from '../../../lib/api';
import type { Server } from '../servers-ui';
import { checklistShown, HIDDEN_KEY, openKeys, parseHidden, reopenedBy, type SetupStep } from '../../../lib/setup-checklist';

// What a health step is based on, in a few words ("Last message failed 2 hours ago: the server refused the sign-in").
function stepDetail(t: ReturnType<typeof useTranslations<'Dashboard'>>, format: ReturnType<typeof useFormatter>, x: SetupStep, reason: (code: string) => string): string {
  const d = x.detail ?? {};
  switch (x.key) {
    case 'mailDelivers': return d.at ? (d.code ? t('steps.detail.mailDeliversWhy', { when: format.relativeTime(new Date(String(d.at))), reason: reason(String(d.code)) }) : t('steps.detail.mailDelivers', { when: format.relativeTime(new Date(String(d.at))) })) : '';
    case 'backupSchedule': return t('steps.detail.backupSchedule', { schedule: String(d.schedule ?? 'off') });
    case 'monitoring': return t('steps.detail.monitoring', { state: String(d.state ?? 'off') });
    case 'updates': return d.latest ? t('steps.detail.updatesWaiting', { latest: String(d.latest), channel: String(d.channel ?? '') }) : t('steps.detail.updatesAuto', { channel: String(d.channel ?? '') });
    case 'payments': return t('steps.detail.payments');
    case 'staffTwoFactor': return t('steps.detail.staffTwoFactor', { n: Number(d.n ?? 0) });
    default: return '';
  }
}

type Layer = Record<string, number>;
type Pool = { id: string; name: string; capacity: { offered: Layer; reserved: Layer; used: Layer; available: Layer } };
type Operation = { id: string; kind: string; status: string; createdAt: string; serverName: string | null };
type Connection = { id: string; status: string };

const chartColors = { success: 'var(--success)', danger: 'var(--danger)', warning: 'var(--warning)', accent: 'var(--accent)', muted: 'var(--muted)', default: 'color-mix(in oklab, var(--muted) 45%, transparent)' };
const tooltipStyle = { background: 'var(--overlay)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--overlay-foreground)', fontSize: 12 };

// Overview for operators: what runs, what is free, what failed. Every number comes from the API.
export default function Dashboard({ setupOpen }: { setupOpen: boolean }) {
  const t = useTranslations('Dashboard');
  const ts = useTranslations('Servers');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const servers = useApiQuery<{ servers: Server[] }>(['admin', 'servers'], '/admin/servers', { refetchInterval: 15_000 }).data?.servers;
  const pools = useApiQuery<{ pools: Pool[] }>(['catalog', 'pools'], '/admin/pools', { refetchInterval: 30_000 }).data?.pools;
  const ops = useApiQuery<{ operations: Operation[] }>(['admin', 'operations'], '/admin/operations', { refetchInterval: 15_000 }).data?.operations;
  const connections = useApiQuery<{ connections: Connection[] }>(['vmware', 'connections'], '/admin/vmware/connections').data?.connections;
  // Setup checklist from the installation's real state (lib/setup-checklist.ts): the start steps, then what keeps it
  // healthy. Shown while a step is open; "Hide until something changes" puts it away until a step opens that was fine.
  const steps = useApiQuery<{ steps: SetupStep[] }>(['admin', 'onboarding'], '/admin/onboarding').data?.steps
    ?.map((x) => ({ ...x, group: x.group ?? 'start' } as SetupStep));
  const doneSteps = steps?.filter((x) => x.done).length ?? 0;
  // Done steps fold away (one tap shows them); the first open step is marked as the next one.
  const [showDone, setShowDone] = useState(false);
  const nextStep = steps?.find((x) => !x.done)?.key;
  const [hidden, setHidden] = useState<string[] | null>(null);
  useEffect(() => { try { setHidden(parseHidden(localStorage.getItem(HIDDEN_KEY))); } catch { /* storage blocked */ } }, []);
  const putAway = () => { const open = openKeys(steps ?? []); setHidden(open); try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(open)); } catch { /* storage blocked */ } };
  const showList = !!steps && checklistShown(steps, hidden);
  const reopened = steps ? reopenedBy(steps, hidden) : [];
  const anyStart = !!steps?.some((x) => x.group === 'start' && !x.done);
  const { code: reason } = useErrorText();
  const detailText = (x: SetupStep) => stepDetail(t, format, x, reason);

  const ready = servers?.filter((s) => s.state === 'ready').length ?? 0;
  const failed24h = ops?.filter((o) => o.status === 'failed' && Date.now() - Date.parse(o.createdAt) < 86_400_000).length ?? 0;
  const open = ops?.filter((o) => o.status === 'pending' || o.status === 'running').length ?? 0;
  const connOk = connections?.filter((c) => c.status === 'ok').length ?? 0;
  const freeVcpu = pools?.reduce((s, p) => s + (p.capacity.available.vcpu ?? 0), 0) ?? 0;
  const offeredVcpu = pools?.reduce((s, p) => s + (p.capacity.offered.vcpu ?? 0), 0) ?? 0;

  const stateData = Object.entries((servers ?? []).reduce<Record<string, number>>((acc, s) => {
    const k = s.state === 'ready' ? (s.powerState === 'poweredOn' ? 'running' : 'stopped') : s.state === 'error' || s.state === 'missing' ? 'problem' : 'busy';
    acc[k] = (acc[k] ?? 0) + 1; return acc;
  }, {})).map(([k, v]) => ({ key: k, name: t(`serverState.${k as 'running'}`), value: v }));
  const stateColor = { running: chartColors.success, stopped: chartColors.default, problem: chartColors.danger, busy: chartColors.accent } as Record<string, string>;

  const days = [...Array(7)].map((_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - i)); return d; });
  const opsData = days.map((d) => {
    const inDay = (ops ?? []).filter((o) => { const c = new Date(o.createdAt); return c >= d && c.getTime() < d.getTime() + 86_400_000; });
    return { day: format.dateTime(d, { weekday: 'short' }), ok: inDay.filter((o) => o.status === 'succeeded').length, failed: inDay.filter((o) => o.status === 'failed').length };
  });
  // The same rows object while the pools are the same: the page redraws every few seconds (operations, servers, the
  // clock), and a chart handed new rows each time starts its bars again from nothing.
  const capacityData = useMemo(() => (pools ?? []).map((p) => ({ name: p.name, used: p.capacity.used.vcpu ?? 0, reserved: p.capacity.reserved.vcpu ?? 0, available: p.capacity.available.vcpu ?? 0 })), [pools]);

  return <div className="flex flex-col gap-6">
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')}/>
    {setupOpen && <Notice tone="accent" title={t('setupIncomplete')}><NextLink href="/setup" className="underline">{t('continueSetup')}</NextLink></Notice>}

    {showList && steps && <Section title={t(anyStart ? 'gettingStarted' : 'setupHealth')} description={t(anyStart ? 'gettingStartedHelp' : 'setupHealthHelp')}
      actions={<span className="flex flex-wrap items-center gap-2"><span className="text-xs tabular-nums text-muted">{t('steps.progress', { done: doneSteps, total: steps.length })}</span>
        <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-9" onPress={putAway}><I name="eye-off" size={14}/>{t('steps.hide')}</Button></span>}>
      {reopened.length > 0 && <p role="status" className="mb-3 flex items-center gap-2 text-sm text-warning"><I name="triangle-alert" size={14}/>{t('steps.reopened', { steps: reopened.map((k) => t(`steps.${k as 'pool'}`)).join(', ') })}</p>}
      <ProgressBar aria-label={t('steps.progress', { done: doneSteps, total: steps.length })} value={Math.round((doneSteps / steps.length) * 100)} size="sm" color="success" className="mb-3">
        <ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>
      {(['start', 'health'] as const).map((g) => steps.some((x) => x.group === g && (!x.done || showDone)) && <div key={g} className="mb-3 last:mb-0">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{t(`steps.group.${g}`)}</h3>
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((x, i) => x.group === g && (!x.done || showDone) && <li key={x.key}>
            <NextLink href={x.link} data-step={x.key} className={`flex h-full min-h-11 items-center gap-3 rounded-lg border px-3 py-3 text-sm transition-colors duration-150 ${x.done ? 'border-success/40 text-muted' : x.key === nextStep ? 'border-accent bg-accent-soft/40 hover:bg-accent-soft' : 'border-border hover:border-accent'}`}>
              <span className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${x.done ? 'bg-success text-success-foreground' : 'bg-default'}`}>{x.done ? <I name="check" size={14}/> : i + 1}</span>
              <span className="min-w-0 flex-1"><span className={x.done ? 'line-through' : 'font-medium'}>{x.done && <span className="sr-only">✓ </span>}{t(`steps.${x.key as 'pool'}`)}</span>
                {!x.done && detailText(x) && <span className="mt-0.5 block text-xs text-muted">{detailText(x)}</span>}
                {x.key === nextStep && <span className="mt-0.5 block text-[11px] font-semibold uppercase tracking-wider text-accent">{t('steps.next')}</span>}</span>
              {!x.done && <I name="arrow-right" size={14} className="shrink-0 text-muted"/>}
            </NextLink>
          </li>)}
        </ol>
      </div>)}
      {doneSteps > 0 && <button type="button" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)} className="mt-1 flex min-h-11 items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground">
        <I name={showDone ? 'chevron-up' : 'chevron-down'} size={14}/>{showDone ? t('steps.hideDone') : t('steps.showDone', { n: doneSteps })}</button>}
      <p className="mt-2 text-xs text-muted">{t('steps.basis')}</p>
    </Section>}

    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <Stat label={t('stat.servers')} value={servers ? <><CountUp value={ready}/> / <CountUp value={servers.length}/></> : '…'} hint={t('stat.serversHint')} icon={<I name="server"/>} tone="success"/>
      <Stat label={t('stat.capacity')} value={pools ? <CountUp value={freeVcpu} format={(n) => format.number(Math.round(n))}/> : '…'} hint={t('stat.capacityHint', { offered: format.number(offeredVcpu) })} icon={<I name="cpu"/>} tone="accent"/>
      <Stat label={t('stat.operations')} value={ops ? <CountUp value={open}/> : '…'} hint={t('stat.failed', { n: failed24h })} icon={<I name="activity"/>} tone={failed24h ? 'danger' : 'default'}/>
      <Stat label={t('stat.connections')} value={connections ? <><CountUp value={connOk}/> / <CountUp value={connections.length}/></> : '…'} hint={t('stat.connectionsHint')} icon={<I name="cable"/>} tone={connections && connOk < connections.length ? 'warning' : 'default'}/>
    </div>

    <Digest/>

    <OnlineNow/>

    <Insights scope="staff"/>

    <div className="grid gap-6 xl:grid-cols-3">
      {/* With no servers yet the state chart has nothing to show; capacity takes the row. */}
      <Card className={stateData.length ? 'xl:col-span-2' : 'xl:col-span-3'}>
        <Card.Header><Card.Title className="text-base font-semibold">{t('chart.capacity')}</Card.Title><Card.Description className="text-xs text-muted">{t('chart.capacityHelp')}</Card.Description></Card.Header>
        <Card.Content>
          {capacityData.length === 0 ? <p className="py-10 text-center text-sm text-muted">{t('noData')}</p> :
            <div role="img" aria-label={t('chart.capacity')} style={{ height: Math.min(256, 90 + capacityData.length * 48) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={capacityData} layout="vertical" margin={{ left: 12, right: 12 }}>
                  <CartesianGrid horizontal={false} stroke="var(--separator)"/>
                  <XAxis type="number" allowDecimals={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--separator)"/>
                  <YAxis type="category" dataKey="name" width={110} tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--separator)"/>
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'color-mix(in oklab, var(--muted) 12%, transparent)' }}/>
                  <Legend wrapperStyle={{ fontSize: 12 }}/>
                  <Bar dataKey="used" name={t('chart.used')} stackId="a" fill={chartColors.warning}/>
                  <Bar dataKey="reserved" name={t('chart.reserved')} stackId="a" fill={chartColors.muted}/>
                  <Bar dataKey="available" name={t('chart.available')} stackId="a" fill={chartColors.success} radius={[0, 4, 4, 0]}/>
                </BarChart>
              </ResponsiveContainer>
            </div>}
        </Card.Content>
      </Card>
      {stateData.length > 0 && <Card>
        <Card.Header><Card.Title className="text-base font-semibold">{t('chart.servers')}</Card.Title></Card.Header>
        <Card.Content>
            <div className="h-64" role="img" aria-label={t('chart.servers')}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={stateData} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="85%" paddingAngle={2} stroke="none">
                    {stateData.map((d) => <Cell key={d.key} fill={stateColor[d.key]}/>)}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle}/>
                  <Legend wrapperStyle={{ fontSize: 12 }}/>
                </PieChart>
              </ResponsiveContainer>
            </div>
        </Card.Content>
      </Card>}
    </div>

    <div className="grid gap-6 xl:grid-cols-3">
      <Card>
        <Card.Header><Card.Title className="text-base font-semibold">{t('chart.operations')}</Card.Title></Card.Header>
        <Card.Content>
          <div className="h-56" role="img" aria-label={t('chart.operations')}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={opsData}>
                <CartesianGrid vertical={false} stroke="var(--separator)"/>
                <XAxis dataKey="day" tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--separator)"/>
                <YAxis allowDecimals={false} width={28} tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--separator)"/>
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'color-mix(in oklab, var(--muted) 12%, transparent)' }}/>
                <Bar dataKey="ok" name={t('chart.succeeded')} stackId="o" fill={chartColors.success}/>
                <Bar dataKey="failed" name={t('chart.failed')} stackId="o" fill={chartColors.danger} radius={[4, 4, 0, 0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card.Content>
      </Card>
      <Section title={t('recent')} className="xl:col-span-2" actions={<NextLink href="/admin/servers?tab=operations" className="text-sm text-accent hover:underline">{t('viewAll')}</NextLink>}>
        <DataTable label={t('recent')} rows={(ops ?? []).slice(0, 6)} rowKey={(o) => o.id} empty={t('noData')} minWidth={520}
          columns={[{ id: 'when', label: ts('col.when') }, { id: 'op', label: ts('col.operation') }, { id: 'name', label: ts('col.name') }, { id: 'state', label: ts('col.state') }]}
          cells={(o) => [format.relativeTime(new Date(o.createdAt), now), ts(`kind.${o.kind as 'create'}`), o.serverName ?? '–',
            <StatusChip key="s" tone={o.status === 'succeeded' ? 'success' : o.status === 'failed' ? 'danger' : o.status === 'cancelled' ? 'default' : 'accent'}>{ts(`opStatus.${o.status as 'pending'}`)}</StatusChip>]}/>
      </Section>
    </div>
  </div>;
}
