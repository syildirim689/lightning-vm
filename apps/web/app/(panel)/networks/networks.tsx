"use client";
// Private networks: the customer's isolated networks per location, the servers on each with their address, joining and
// leaving, and how to set the address inside the server (netplan, matched by the new interface's MAC).
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../components/icon';
import { ConfirmButton, Empty, Mono, Notice, PageHeader, Section, SelectInput, StatusChip, TextInput } from '../../../components/ui';
import { apiFetch, type ApiError, useErrorText } from '../../../lib/api';
import { useApiQuery } from '../../../lib/query';
import { Copy } from '../server-extras';

type Member = { serverId: string; name: string; address: string; mac: string | null; status: 'joining' | 'joined' | 'leaving' | 'failed' };
type Network = { id: string; name: string; cidr: string; vlan: number; poolId: string; poolName: string; createdAt: string; members: Member[] };
type Data = { networks: Network[]; pools: { id: string; name: string; location: string }[]; max: number };
type ServerLite = { id: string; name: string; poolId: string; state: string };

function netplan(m: Member, cidr: string) {
  const bits = cidr.split('/')[1];
  return `network:\n  version: 2\n  ethernets:\n    private0:\n      match:\n        macaddress: "${m.mac ?? ''}"\n      set-name: private0\n      addresses: [${m.address}/${bits}]`;
}

function NetworkCard({ n, servers, onChange }: { n: Network; servers: ServerLite[]; onChange: () => void }) {
  const t = useTranslations('Networks');
  const { error } = useErrorText();
  const [serverId, setServerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string>();
  async function run(path: string, method: string, body: object | undefined, done: string) {
    setBusy(true);
    try { await apiFetch(path, { method, body }); toast.success(done); setServerId(''); onChange(); } catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  const candidates = servers.filter((s) => s.poolId === n.poolId && s.state === 'ready' && !n.members.some((m) => m.serverId === s.id));
  const only = candidates.length === 1 ? candidates[0].id : '';
  useEffect(() => { if (only) setServerId(only); }, [only]);
  async function joinAll() {
    setBusy(true);
    let done = 0;
    try { for (const s of candidates) { await apiFetch(`/networks/${n.id}/servers`, { method: 'POST', body: { serverId: s.id } }); done += 1; } }
    catch (e) { toast.danger(error(e)); }
    finally { if (done) toast.success(t('joinedAll', { n: done })); setServerId(''); setBusy(false); onChange(); }
  }
  // Lines for /etc/hosts: every connected server by name, so they find each other without remembering addresses.
  const joined = n.members.filter((m) => m.status === 'joined');
  const hosts = joined.map((m) => `${m.address} ${m.name}`).join('\n');
  // Usable addresses: the subnet minus its network and broadcast address.
  const total = Math.max(2 ** (32 - Number(n.cidr.split('/')[1] ?? 24)) - 2, 1);
  const pct = Math.min(100, Math.round((n.members.length / total) * 100));
  return <Section title={n.name} description={<span className="flex flex-wrap gap-2"><Mono>{n.cidr}</Mono><span>{n.poolName}</span><span>{t('vlan', { vlan: n.vlan })}</span></span>}
    actions={<ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={t('remove')} title={t('removeTitle')} body={t('removeBody')}
      confirmLabel={t('remove')} cancelLabel={t('cancel')} isDisabled={n.members.length > 0} onConfirm={() => run(`/networks/${n.id}`, 'DELETE', undefined, t('removed'))}/>}>
    <div className="flex flex-col gap-4">
      {n.members.length > 0 && <p className="text-xs text-muted">{t('removeBlocked', { n: n.members.length })}</p>}
      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-default" role="meter" aria-label={t('usage')} aria-valuenow={n.members.length} aria-valuemin={0} aria-valuemax={total}>
          <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(pct, n.members.length ? 2 : 0)}%` }}/></span>
        <span className="shrink-0 tabular-nums">{t('used', { n: n.members.length, free: total - n.members.length })}</span>
      </div>
      {n.members.length === 0 ? <p className="text-sm text-muted">{t('noMembers')}</p>
        : <ul className="flex flex-col divide-y divide-separator rounded-lg border border-border">{n.members.map((m) => <li key={m.serverId} className="flex flex-col gap-2 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <NextLink href={`/servers/${m.serverId}`} className="font-medium text-accent hover:underline">{m.name}</NextLink>
            <span className="flex items-center"><Mono>{m.address}</Mono><Copy text={m.address} label={m.address}/></span>
            <StatusChip tone={m.status === 'joined' ? 'success' : m.status === 'failed' ? 'danger' : 'accent'}>{t(`status.${m.status}`)}</StatusChip>
            <span className="ml-auto flex gap-1">
              {m.status === 'joined' && m.mac && <Button size="sm" variant="ghost" aria-expanded={open === m.serverId} onPress={() => setOpen(open === m.serverId ? undefined : m.serverId)}><I name="terminal" size={14}/>{t('setup')}</Button>}
              {(m.status === 'joined' || m.status === 'failed') && <ConfirmButton size="sm" variant="ghost" icon={<I name="unplug" size={14}/>} label={t('leave')} title={t('leaveTitle')} body={t('leaveBody')}
                confirmLabel={t('leave')} cancelLabel={t('cancel')} onConfirm={() => run(`/networks/${n.id}/servers/${m.serverId}`, 'DELETE', undefined, t('left'))}/>}
            </span>
          </div>
          {open === m.serverId && <div className="flex flex-col gap-1 text-xs"><p className="text-muted">{t('setupHelp', { mac: m.mac ?? '' })}</p>
            <div className="relative"><pre className="overflow-x-auto rounded-lg bg-default p-3 pr-12">{netplan(m, n.cidr)}</pre>
              <Copy text={netplan(m, n.cidr)} label={t('netplan')} className="absolute right-1 top-1"/></div></div>}
        </li>)}</ul>}
      {candidates.length === 0 && <p className="flex flex-wrap items-center gap-2 text-xs text-muted"><I name="info" size={13}/>{t('noCandidates', { location: n.poolName })}
        <NextLink href="/order" className="text-accent hover:underline">{t('orderOne')}</NextLink></p>}
      {candidates.length > 0 && <div className="flex flex-wrap items-end gap-3">
        <SelectInput className="min-w-56 flex-1" label={t('choose')} value={serverId} onChange={setServerId} options={candidates.map((s) => ({ id: s.id, label: s.name }))}/>
        <Button variant="secondary" isPending={busy} isDisabled={!serverId} onPress={() => run(`/networks/${n.id}/servers`, 'POST', { serverId }, t('joining'))}><I name="plug" size={15}/>{t('join')}</Button>
        {candidates.length > 1 && candidates.length <= total - n.members.length && <Button variant="ghost" isDisabled={busy} onPress={joinAll}><I name="plus" size={15}/>{t('joinAll', { n: candidates.length })}</Button>}
      </div>}
      {joined.length > 1 && <div className="flex flex-wrap items-center gap-2 text-xs text-muted"><I name="info" size={13}/>{t('hostsHelp')}
        <Button size="sm" variant="ghost" onPress={async () => { await navigator.clipboard?.writeText(hosts).catch(() => undefined); toast.success(t('hostsCopied', { n: joined.length })); }}><I name="copy" size={13}/>{t('hostsCopy')}</Button></div>}
    </div>
  </Section>;
}

export default function Networks() {
  const t = useTranslations('Networks');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<Data>(['networks'], '/networks', { refetchInterval: 10_000 });
  const servers = useApiQuery<{ servers: ServerLite[] }>(['servers'], '/servers').data?.servers ?? [];
  const [v, setV] = useState({ name: '', poolId: '', cidr: '' });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const refresh = () => { void client.invalidateQueries({ queryKey: ['networks'] }); void client.invalidateQueries({ queryKey: ['servers'] }); };
  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFields({});
    try { await apiFetch('/networks', { method: 'POST', body: v }); toast.success(t('created')); setV({ name: '', poolId: v.poolId, cidr: '' }); refresh(); }
    catch (err) { setFields((err as ApiError).fields ?? {}); toast.danger(error(err)); } finally { setBusy(false); }
  }
  const d = q.data;
  const onlyPool = d?.pools.length === 1 ? d.pools[0].id : '';
  useEffect(() => { if (onlyPool) setV((x) => (x.poolId ? x : { ...x, poolId: onlyPool })); }, [onlyPool]);
  const full = !!d && d.networks.length >= d.max;
  return <>
    <PageHeader title={t('title')} description={t('intro')} actions={d && <span className={`rounded-full border px-3 py-1 text-xs font-medium tabular-nums ${full ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border text-muted'}`}>
      {t('count', { n: d.networks.length, max: d.max })}</span>}/>
    {!d ? <div className="h-48 animate-pulse rounded-3xl bg-default/50"/> : <div className="flex flex-col gap-6">
      {d.pools.length === 0 ? <Notice tone="default">{t('noLocations')}</Notice>
        : <Section title={t('create')}>
          <form onSubmit={create} noValidate className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <TextInput label={t('name')} value={v.name} onChange={(x) => setV({ ...v, name: x })} maxLength={60} error={field(fields.name)} placeholder="backend"/>
            <SelectInput label={t('location')} value={v.poolId} onChange={(x) => setV({ ...v, poolId: x })} error={field(fields.poolId)} options={d.pools.map((p) => ({ id: p.id, label: p.location ? `${p.name} · ${p.location}` : p.name }))}/>
            <TextInput format="privateCidr" label={t('subnet')} value={v.cidr} onChange={(x) => setV({ ...v, cidr: x })} error={field(fields.cidr)} placeholder="10.10.0.0/24" help={t('subnetHelp')}/>
            <Button type="submit" isPending={busy} isDisabled={!v.name.trim() || !v.poolId || full}><I name="plus" size={15}/>{t('add')}</Button>
          </form>
          {full && <p className="mt-3 flex items-center gap-2 text-xs text-warning"><I name="triangle-alert" size={13}/>{t('limit', { max: d.max })}</p>}
        </Section>}
      {d.networks.length === 0 ? <Empty icon={<I name="network" size={28}/>} title={t('none')}>{t('noneHelp')}</Empty>
        : d.networks.map((n) => <NetworkCard key={n.id} n={n} servers={servers} onChange={refresh}/>)}
    </div>}
  </>;
}
