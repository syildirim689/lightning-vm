"use client";
// Topology pages. Admin: Internet -> location -> cluster -> host -> servers (live load and traffic from VMware,
// refreshed every 15 s). Customer: Internet -> location -> own servers, with the firewalls on each link.
import { Tabs } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../components/icon';
import { rate, Topology, type TopoNode } from '../../components/topology';
import { ButtonLink, DataTable, Empty, Notice, PageHeader, Stat, StatusChip } from '../../components/ui';
import { flag } from '../../lib/flag';
import { useApiQuery } from '../../lib/query';

type Loc = { id: string; name: string; city: string; countryCode: string; datacenter: string; status: string };
type Server = { id: string; name: string; state: string; address: string | null; vcpu: number; memoryMb: number; locationId: string | null; firewalls: string[];
  owner?: string; computeMoref?: string; power: string | null; host: string | null; cpuUsedMhz: number | null; memUsedMb: number | null; rxKBps: number | null; txKBps: number | null };
type Conn = { id: string; name: string; kind: string; host: string; error?: string; compute?: { moref: string; name: string; kind: string }[];
  hosts?: { moref: string; name: string; compute: string; state: string; cpuUsedMhz: number; cpuTotalMhz: number; memUsedMb: number; memTotalMb: number }[];
  datastores?: { name: string; capacityGb: number; freeGb: number }[]; otherVms?: number; servers: Server[] };
type AdminData = { locations: Loc[]; pools: { connectionId: string; computeMoref: string; locationId: string | null }[]; connections: Conn[] };

const MAX_PER_HOST = 6;
// The translator, untyped: the keys here are built from data (states, kinds).
type Tr = (key: string, values?: Record<string, string | number>) => string;
const serverTone = (s: Server) => (s.state === 'error' ? 'danger' : s.state !== 'ready' ? 'warning' : s.power === 'poweredOn' ? 'success' : 'muted');

function serverNode(s: Server, t: Tr): TopoNode {
  return { id: `s-${s.id}`, kind: 'server', label: s.name, tone: serverTone(s), rx: s.rxKBps, tx: s.txKBps, badges: s.firewalls.length ? s.firewalls : undefined,
    sub: s.address ?? t(`states.${s.state}`),
    details: [[t('address'), s.address ?? '–'], [t('size'), `${s.vcpu} vCPU · ${s.memoryMb / 1024} GB`], [t('power'), s.power ?? '–'],
      ...(s.owner ? [[t('owner'), s.owner] as [string, string]] : []), ...(s.firewalls.length ? [[t('firewalls'), s.firewalls.join(', ')] as [string, string]] : [])] };
}

// The busiest servers of a group, the rest folded into one "+N" node.
function capped(servers: Server[], key: string, t: Tr): TopoNode[] {
  const sorted = [...servers].sort((a, b) => ((b.rxKBps ?? 0) + (b.txKBps ?? 0)) - ((a.rxKBps ?? 0) + (a.txKBps ?? 0)));
  const shown = sorted.slice(0, MAX_PER_HOST).map((s) => serverNode(s, t));
  const rest = sorted.slice(MAX_PER_HOST);
  if (rest.length) shown.push({ id: `more-${key}`, kind: 'more', label: t('more', { n: rest.length }), tone: 'muted',
    rx: rest.reduce((a, s) => a + (s.rxKBps ?? 0), 0), tx: rest.reduce((a, s) => a + (s.txKBps ?? 0), 0) });
  return shown;
}

function adminTree(d: AdminData, t: Tr): TopoNode {
  const locOf = (c: string, m: string) => d.pools.find((p) => p.connectionId === c && p.computeMoref === m && p.locationId)?.locationId ?? null;
  const computeNode = (c: Conn, cr: { moref: string; name: string; kind: string }): TopoNode => {
    const hosts = (c.hosts ?? []).filter((h) => h.compute === cr.moref);
    return { id: `c-${c.id}-${cr.moref}`, kind: 'compute', label: cr.name, sub: `${c.name} · ${t(`computeKinds.${cr.kind}`)}`,
      details: [[t('connection'), `${c.name} (${c.host})`], [t('hosts'), String(hosts.length)]],
      children: hosts.map((h) => ({ id: `h-${c.id}-${h.moref}`, kind: 'host' as const, label: h.name, tone: h.state !== 'connected' ? 'danger' as const : undefined,
        bars: [{ label: 'CPU', value: h.cpuTotalMhz ? h.cpuUsedMhz / h.cpuTotalMhz : 0 }, { label: 'RAM', value: h.memTotalMb ? h.memUsedMb / h.memTotalMb : 0 }],
        details: [[t('state'), h.state], ['CPU', `${Math.round(h.cpuUsedMhz)} / ${h.cpuTotalMhz} MHz`], ['RAM', `${Math.round(h.memUsedMb / 1024)} / ${Math.round(h.memTotalMb / 1024)} GB`]] as [string, string][],
        children: capped(c.servers.filter((s) => s.host === h.moref), `${c.id}-${h.moref}`, t) })) };
  };
  const located: Record<string, TopoNode[]> = {};
  const loose: TopoNode[] = [];
  for (const c of d.connections) {
    if (c.error) { loose.push({ id: `x-${c.id}`, kind: 'connection', label: c.name, sub: t('unreachable', { code: c.error }), tone: 'danger' }); continue; }
    const unlocated: TopoNode[] = [];
    for (const cr of c.compute ?? []) {
      const node = computeNode(c, cr);
      if (!node.children?.length) continue;
      const l = locOf(c.id, cr.moref);
      if (l) (located[l] ??= []).push(node); else unlocated.push(node);
    }
    if (unlocated.length) loose.push({ id: `x-${c.id}`, kind: 'connection', label: c.name, sub: c.host, children: unlocated });
  }
  return { id: 'internet', kind: 'internet', label: t('internet'), children: [
    ...d.locations.filter((l) => located[l.id]).map((l) => ({ id: `l-${l.id}`, kind: 'location' as const, label: `${flag(l.countryCode)} ${l.name}`.trim(),
      sub: [l.city, l.datacenter].filter(Boolean).join(' · ') || undefined, tone: l.status === 'maintenance' ? 'warning' as const : undefined, children: located[l.id] })),
    ...loose] };
}

function customerTree(d: { locations: Loc[]; servers: Server[] }, t: Tr): TopoNode {
  const groups = [...d.locations.map((l) => ({ id: l.id, l })), { id: null as string | null, l: null as Loc | null }];
  return { id: 'internet', kind: 'internet', label: t('internet'), children: groups.map(({ id, l }) => {
    const servers = d.servers.filter((s) => (s.locationId ?? null) === id || (id === null && !d.locations.some((x) => x.id === s.locationId)));
    if (!servers.length) return null;
    return { id: `l-${id ?? 'none'}`, kind: 'location' as const, label: l ? `${flag(l.countryCode)} ${l.name}`.trim() : t('otherLocation'), sub: l ? [l.city, l.datacenter].filter(Boolean).join(' · ') : undefined,
      children: servers.map((s) => serverNode(s, t)) };
  }).filter((x): x is NonNullable<typeof x> => !!x) };
}

function Totals({ servers, hosts }: { servers: Server[]; hosts?: { cpuUsedMhz: number; cpuTotalMhz: number }[] }) {
  const t = useTranslations('Topology');
  const rx = servers.reduce((a, s) => a + (s.rxKBps ?? 0), 0), tx = servers.reduce((a, s) => a + (s.txKBps ?? 0), 0);
  const cpu = hosts?.length ? hosts.reduce((a, h) => a + h.cpuUsedMhz, 0) / Math.max(1, hosts.reduce((a, h) => a + h.cpuTotalMhz, 0)) : null;
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    <Stat label={t('servers')} value={servers.length} hint={t('running', { n: servers.filter((s) => s.power === 'poweredOn').length })} icon={<I name="server" size={18}/>}/>
    <Stat label={t('inbound')} value={rate(rx)} icon={<I name="arrow-down-to-line" size={18}/>} tone="accent"/>
    <Stat label={t('outbound')} value={rate(tx)} icon={<I name="arrow-up-from-line" size={18}/>} tone="success"/>
    {cpu !== null ? <Stat label={t('hostCpu')} value={`${Math.round(cpu * 100)}%`} hint={t('hostsN', { n: hosts!.length })} icon={<I name="cpu" size={18}/>} tone={cpu > 0.85 ? 'danger' : cpu > 0.6 ? 'warning' : 'default'}/>
      : <Stat label={t('firewalled')} value={servers.filter((s) => s.firewalls.length).length} icon={<I name="brick-wall-fire" size={18}/>}/>}
  </div>;
}

function Table({ servers }: { servers: Server[] }) {
  const t = useTranslations('Topology');
  return <DataTable label={t('table')} rows={servers} rowKey={(s) => s.id} empty={t('empty')} minWidth={720}
    columns={[{ id: 'n', label: t('server') }, { id: 'st', label: t('state') }, { id: 'ip', label: t('address') }, { id: 'rx', label: t('inbound') }, { id: 'tx', label: t('outbound') }, { id: 'fw', label: t('firewalls') }]}
    cells={(s) => [<span key="n" className="font-medium">{s.name}</span>, <StatusChip key="s" tone={serverTone(s) === 'muted' ? 'default' : serverTone(s) as 'success'}>{s.power ?? s.state}</StatusChip>,
      s.address ?? '–', rate(s.rxKBps), rate(s.txKBps), s.firewalls.join(', ') || '–']}/>;
}

export function TopologyPage({ admin }: { admin: boolean }) {
  const t = useTranslations('Topology');
  const [view, setView] = useState('map');
  const a = useApiQuery<AdminData>(['topology', 'admin'], admin ? '/admin/topology' : null, { refetchInterval: 15_000 });
  const c = useApiQuery<{ locations: Loc[]; servers: Server[] }>(['topology', 'mine'], admin ? null : '/topology', { refetchInterval: 15_000 });
  const servers = admin ? (a.data?.connections.flatMap((x) => x.servers) ?? []) : (c.data?.servers ?? []);
  const ready = admin ? !!a.data : !!c.data;
  const tr = t as unknown as Tr;
  const root = !ready ? null : admin ? adminTree(a.data!, tr) : customerTree(c.data!, tr);
  return <>
    <PageHeader eyebrow={admin ? t('eyebrowAdmin') : undefined} title={t('title')} description={admin ? t('introAdmin') : t('intro')}/>
    {!ready ? <p role="status" className="text-sm text-muted">{t('loading')}</p> : <div className="flex flex-col gap-5">
      <Totals servers={servers} hosts={admin ? a.data!.connections.flatMap((x) => x.hosts ?? []) : undefined}/>
      {admin && a.data!.connections.filter((x) => x.error).map((x) => <Notice key={x.id} tone="danger">{t('connectionError', { name: x.name, code: x.error! })}</Notice>)}
      <Tabs selectedKey={view} onSelectionChange={(k) => setView(String(k))}>
        <Tabs.ListContainer><Tabs.List aria-label={t('title')}>
          <Tabs.Tab id="map" className="gap-2"><I name="network" size={16}/>{t('map')}<Tabs.Indicator/></Tabs.Tab>
          <Tabs.Tab id="table" className="gap-2"><I name="table" size={16}/>{t('table')}<Tabs.Indicator/></Tabs.Tab>
        </Tabs.List></Tabs.ListContainer>
        <Tabs.Panel id="map" className="pt-4">{root && (root.children?.length ? <Topology root={root} label={t('title')}/>
          : <Empty icon={<I name="network" size={28}/>} title={t('empty')}>{admin ? t('emptyAdmin') : t('emptyHelp')}
            <span className="mt-3 flex justify-center">{admin ? <ButtonLink href="/admin/vmware" variant="secondary"><I name="plug" size={16}/>{t('addConnection')}</ButtonLink>
              : <ButtonLink href="/order"><I name="plus" size={16}/>{t('newServer')}</ButtonLink>}</span></Empty>)}</Tabs.Panel>
        <Tabs.Panel id="table" className="pt-4"><Table servers={servers}/></Tabs.Panel>
      </Tabs>
      <p className="text-xs text-muted">{t('refresh')}</p>
    </div>}
  </>;
}
