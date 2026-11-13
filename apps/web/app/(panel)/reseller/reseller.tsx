"use client";
// The reseller's page: the allocation and how much of it is used, the customers, a new customer, and per customer
// their servers and an order made for them (billed to the reseller at the reseller's discount).
import { Button, ProgressBar, toast } from '@heroui/react';
import { useUnits } from '../../../lib/units';
import { useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../components/icon';
import { DataTable, Empty, Mono, Notice, PageHeader, Section, SelectInput, StatusChip, TextInput } from '../../../components/ui';
import { apiFetch, type ApiError, useErrorText } from '../../../lib/api';
import { fold } from '../../../lib/note-line';
import { useApiQuery } from '../../../lib/query';
import { Copy } from '../server-extras';

type Allocation = { discountPct: number; maxCustomers: number | null; maxServers: number | null; maxVcpu: number | null; maxMemoryMb: number | null; maxDiskGb: number | null };
type Usage = { servers: number; vcpu: number; memoryMb: number; diskGb: number; monthly: string; currency: string | null; customers: number };
type Customer = { id: string; email: string; name: string; createdAt: string; lastSeenAt: string | null; servers: number; monthly: string; currency: string | null };
type Catalog = { packages: { id: string; name: string; vcpu: number; memoryMb: number; diskGb: number; priceMonthly: string; currency: string; poolIds: string[]; imageIds: string[] }[];
  pools: { id: string; name: string; location: string }[]; images: { id: string; name: string; minDiskGb: number }[] };

function Meter({ label, used, max, unit = '' }: { label: string; used: number; max: number | null; unit?: string }) {
  const t = useTranslations('Reseller');
  const pct = max ? Math.min(100, (used / max) * 100) : 0;
  return <div className="flex flex-col gap-1.5 rounded-xl border border-border p-3">
    <div className="flex items-baseline justify-between gap-2"><span className="text-xs uppercase tracking-wider text-muted">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{used}{unit}{max !== null ? ` / ${max}${unit}` : ` · ${t('unlimited')}`}</span></div>
    {max !== null && <ProgressBar aria-label={label} value={pct} size="sm" color={pct >= 90 ? 'danger' : pct >= 75 ? 'warning' : 'accent'}><ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>}
  </div>;
}

function OrderForCustomer({ customer, discount, onDone }: { customer: Customer; discount: number; onDone: () => void }) {
  const { memory } = useUnits();
  const t = useTranslations('Reseller');
  const format = useFormatter();
  const { error, field } = useErrorText();
  const catalog = useApiQuery<Catalog>(['catalog'], '/catalog').data;
  const keys = useApiQuery<{ keys: { id: string; name: string; fingerprint: string }[] }>(['ssh-keys'], '/ssh-keys').data?.keys;
  const [picked, setPicked] = useState({ poolId: '', packageId: '', imageId: '', name: '', sshKey: '', sshKeyId: '' });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (!catalog) return null;
  // Smart defaults: a list with one choice is chosen for you, and your newest saved key is offered first.
  const only = <T extends { id: string }>(list: T[], id: string) => (id || list.length !== 1 ? id : list[0]!.id);
  const poolId = only(catalog.pools, picked.poolId);
  const packages = catalog.packages.filter((p) => !poolId || p.poolIds.includes(poolId));
  const packageId = only(packages, picked.packageId);
  const pkg = catalog.packages.find((p) => p.id === packageId);
  const images = catalog.images.filter((i) => !pkg?.imageIds.length || pkg.imageIds.includes(i.id));
  const imageId = only(images, picked.imageId);
  const sshKeyId = picked.sshKeyId === '' && keys?.length ? keys[0]!.id : picked.sshKeyId === 'paste' ? '' : picked.sshKeyId;
  const v = { ...picked, poolId, packageId, imageId, sshKeyId };
  // The key choice is kept as picked ('' = newest saved key, 'paste' = typed), not as resolved.
  const setV = (n: typeof v) => setPicked({ ...n, sshKeyId: picked.sshKeyId });
  const set = (k: keyof typeof v) => (x: string) => setV({ ...v, [k]: x });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFields({});
    try {
      const { sshKey, sshKeyId: keyId, ...rest } = v;
      await apiFetch(`/reseller/customers/${customer.id}/servers`, { method: 'POST', body: { ...rest, type: 'package', ...(keyId ? { sshKeyId: keyId } : { sshKey }) } });
      toast.success(t('ordered', { name: v.name })); onDone();
    } catch (err) { setFields((err as ApiError).fields ?? {}); toast.danger(error(err)); } finally { setBusy(false); }
  }
  return <form onSubmit={submit} noValidate className="grid gap-3 rounded-xl border border-accent/40 bg-accent-soft/40 p-3 sm:grid-cols-2">
    <SelectInput label={t('location')} value={v.poolId} onChange={(x) => setV({ ...v, poolId: x, packageId: '' })} error={field(fields.poolId)} options={catalog.pools.map((p) => ({ id: p.id, label: p.location ? `${p.name} · ${p.location}` : p.name }))}/>
    <SelectInput label={t('package')} value={v.packageId} onChange={set('packageId')} error={field(fields.packageId)}
      options={packages.map((p) => ({ id: p.id, label: p.name, description: `${p.vcpu} vCPU · ${memory(p.memoryMb)} · ${p.diskGb} GB` }))}/>
    <SelectInput label={t('image')} value={v.imageId} onChange={set('imageId')} error={field(fields.imageId)} options={images.map((i) => ({ id: i.id, label: i.name }))}/>
    <TextInput format="serverName" label={t('hostname')} value={v.name} onChange={(x) => setV({ ...v, name: x.toLowerCase() })} error={field(fields.name)} placeholder="web-1"/>
    {!!keys?.length && <div className="sm:col-span-2"><SelectInput label={t('sshKeyPick')} value={v.sshKeyId || 'paste'} onChange={(x) => setPicked({ ...v, sshKeyId: x })} error={field(fields.sshKeyId)}
      help={t('sshKeyPickHelp')} options={[...keys.map((k) => ({ id: k.id, label: k.name, description: k.fingerprint })), { id: 'paste', label: t('sshKeyPaste') }]}/></div>}
    {!v.sshKeyId && <div className="sm:col-span-2"><TextInput format="sshKey" label={t('sshKey')} value={v.sshKey} onChange={set('sshKey')} multiline error={field(fields.sshKey) ?? field(fields.sshKeyIds)} help={t('sshKeyHelp')}/></div>}
    {pkg && <p className="flex flex-wrap items-baseline gap-2 text-sm sm:col-span-2"><I name="receipt" size={14} className="self-center text-muted"/>{t('priceYou')}
      <strong className="tabular-nums">{format.number(Number(pkg.priceMonthly) * (1 - discount / 100), { style: 'currency', currency: pkg.currency })}</strong>
      {discount > 0 && <span className="text-xs text-muted line-through tabular-nums">{format.number(Number(pkg.priceMonthly), { style: 'currency', currency: pkg.currency })}</span>}
      <span className="text-xs text-muted">{t('perMonth')}</span></p>}
    <div className="flex flex-wrap gap-2 sm:col-span-2">
      <Button type="submit" isPending={busy} isDisabled={!v.poolId || !v.packageId || !v.imageId || !v.name || (!v.sshKeyId && !v.sshKey.trim())}><I name="rocket" size={15}/>{t('order')}</Button>
      <Button variant="ghost" onPress={onDone}>{t('cancel')}</Button>
    </div>
  </form>;
}

function CustomerRow({ c, discount }: { c: Customer; discount: number }) {
  const t = useTranslations('Reseller');
  const format = useFormatter();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const q = useApiQuery<{ servers: { id: string; name: string; state: string; powerState: string; vcpu: number; memoryMb: number; diskGb: number; priceMonthly: string; currency: string; address: string | null }[] }>(
    ['reseller', 'customer', c.id], open ? `/reseller/customers/${c.id}` : null);
  return <li className="rounded-2xl border border-border p-3">
    <div className="flex flex-wrap items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-default text-sm font-semibold" aria-hidden>{(c.name || c.email)[0]!.toUpperCase()}</span>
      <span className="flex min-w-0 flex-1 flex-col"><span className="truncate font-medium">{c.name || c.email}</span><span className="truncate text-xs text-muted">{c.email}{' · '}{c.lastSeenAt ? t('lastSeen', { when: format.relativeTime(new Date(c.lastSeenAt)) }) : t('neverSeen')}</span></span>
      <StatusChip tone="default">{t('serverCount', { n: c.servers })}</StatusChip>
      <span className="text-sm tabular-nums">{c.currency ? format.number(Number(c.monthly), { style: 'currency', currency: c.currency }) : '–'}</span>
      <Button size="sm" variant="ghost" aria-expanded={open} onPress={() => setOpen(!open)}><I name={open ? 'chevron-up' : 'chevron-down'} size={14}/>{t('details')}</Button>
    </div>
    {open && <div className="mt-3 flex flex-col gap-3">
      {!q.data ? <div className="h-16 animate-pulse rounded-xl bg-default/50"/> : q.data.servers.length === 0 ? <p className="text-sm text-muted">{t('noServers')}</p>
        : <DataTable label={t('servers')} rows={q.data.servers} rowKey={(s) => s.id} minWidth={520}
          columns={[{ id: 'n', label: t('server') }, { id: 'ip', label: 'IP' }, { id: 'size', label: t('size') }, { id: 'state', label: t('state') }]}
          cells={(s) => [<NextLink key="n" href={`/servers/${s.id}`} className="font-medium text-accent hover:underline">{s.name}</NextLink>, s.address ? <span key="ip" className="flex items-center gap-1"><Mono>{s.address}</Mono><Copy text={s.address} label={`${s.name} IP`}/></span> : '–',
            `${s.vcpu} vCPU · ${format.number(s.memoryMb / 1024, { maximumFractionDigits: 1 })} GB · ${s.diskGb} GB`, <StatusChip key="s" tone={s.state === 'ready' ? (s.powerState === 'poweredOn' ? 'success' : 'default') : 'warning'}>{t(`states.${s.state === 'ready' ? (s.powerState === 'poweredOn' ? 'on' : 'off') : 'busy'}`)}</StatusChip>]}/>}
      {ordering ? <OrderForCustomer customer={c} discount={discount} onDone={() => { setOrdering(false); void client.invalidateQueries({ queryKey: ['reseller'] }); }}/>
        : <div><Button size="sm" variant="secondary" onPress={() => setOrdering(true)}><I name="plus" size={14}/>{t('orderFor')}</Button></div>}
    </div>}
  </li>;
}

// The reseller's name and colour, shown to their customers in the panel.
function BrandForm() {
  const t = useTranslations('Reseller');
  const { error, field } = useErrorText();
  const q = useApiQuery<{ name?: string; accent?: string | null }>(['reseller', 'brand'], '/reseller/brand');
  const [v, setV] = useState<{ name: string; accent: string } | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (!q.data) return null;
  const doc = v ?? { name: q.data.name ?? '', accent: q.data.accent ?? '#2563eb' };
  const shown = doc.name.trim() || t('brandNamePlaceholder');
  async function save() {
    setBusy(true); setFields({});
    try { await apiFetch('/reseller/brand', { method: 'PUT', body: doc }); toast.success(t('brandSaved')); }
    catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Section title={t('brand')} description={t('brandHelp')}>
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
      <TextInput label={t('brandName')} value={doc.name} onChange={(x) => setV({ ...doc, name: x })} maxLength={60} placeholder={t('brandNamePlaceholder')}/>
      <label className="flex flex-col gap-1 text-sm"><span>{t('brandAccent')}</span>
        <input type="color" value={doc.accent} onChange={(e) => setV({ ...doc, accent: e.target.value })} className="h-10 w-20 cursor-pointer rounded-lg border border-border bg-surface" aria-label={t('brandAccent')}/>
        {fields.accent && <span className="text-xs text-danger">{field(fields.accent)}</span>}</label>
      <Button isPending={busy} onPress={save}><I name="palette" size={15}/>{t('brandSave')}</Button>
    </div>
    {/* What customers see in the panel corner, as it is being typed. */}
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border p-3">
      <span className="text-xs uppercase tracking-wider text-muted">{t('brandPreview')}</span>
      <span className="flex items-center gap-2"><span aria-hidden className="grid size-8 place-items-center rounded-lg text-sm font-bold text-white" style={{ background: doc.accent }}>{shown[0]!.toUpperCase()}</span>
        <span className="font-semibold">{shown}</span></span>
      <span aria-hidden className="rounded-full px-3 py-1 text-xs font-medium text-white" style={{ background: doc.accent }}>{t('order')}</span>
    </div>
    <p className="mt-2 text-xs text-muted">{t('brandNote')}</p>
  </Section>;
}

export default function Reseller() {
  const t = useTranslations('Reseller');
  const format = useFormatter();
  const locale = useLocale();
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const s = useApiQuery<{ allocation: Allocation | null; usage?: Usage }>(['reseller', 'summary'], '/reseller/summary');
  const c = useApiQuery<{ customers: Customer[] }>(['reseller', 'customers'], s.data?.allocation ? '/reseller/customers' : null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('name');
  if (s.error) return <><PageHeader title={t('title')}/><Notice tone="warning">{error(s.error)}</Notice></>;
  if (!s.data) return <div className="h-48 animate-pulse rounded-3xl bg-default/50"/>;
  if (!s.data.allocation || !s.data.usage) return <><PageHeader title={t('title')}/><Notice tone="default">{t('notReseller')}</Notice></>;
  const a = s.data.allocation; const u = s.data.usage;
  async function add(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFields({});
    try { await apiFetch('/reseller/customers', { method: 'POST', body: { email, name } }); toast.success(t('added', { email })); setEmail(''); setName(''); void client.invalidateQueries({ queryKey: ['reseller'] }); }
    catch (err) { setFields((err as ApiError).fields ?? {}); toast.danger(error(err)); } finally { setBusy(false); }
  }
  const list = (c.data?.customers ?? []).filter((x) => !search || fold(`${x.email} ${x.name}`).includes(fold(search)))
    .sort((x, y) => sort === 'monthly' ? Number(y.monthly) - Number(x.monthly) : sort === 'servers' ? y.servers - x.servers : (x.name || x.email).localeCompare(y.name || y.email, locale));
  return <>
    <PageHeader title={t('title')} description={t('intro', { discount: a.discountPct })}/>
    <div className="flex flex-col gap-6">
      <Section title={t('allocation')} description={t('monthly', { amount: u.currency ? format.number(Number(u.monthly), { style: 'currency', currency: u.currency }) : '–' })}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Meter label={t('customers')} used={u.customers} max={a.maxCustomers}/>
          <Meter label={t('servers')} used={u.servers} max={a.maxServers}/>
          <Meter label="vCPU" used={u.vcpu} max={a.maxVcpu}/>
          <Meter label="RAM" used={Math.round(u.memoryMb / 1024)} max={a.maxMemoryMb === null ? null : Math.round(a.maxMemoryMb / 1024)} unit=" GB"/>
          <Meter label={t('disk')} used={u.diskGb} max={a.maxDiskGb} unit=" GB"/>
        </div>
      </Section>
      <BrandForm/>
      <Section title={t('customersTitle')} description={t('customersHelp')}>
        <div className="flex flex-col gap-4">
          <form onSubmit={add} noValidate className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <TextInput label={t('email')} type="email" value={email} onChange={setEmail} error={field(fields.email)}/>
            <TextInput label={t('name')} value={name} onChange={setName}/>
            <Button type="submit" isPending={busy} isDisabled={!email}><I name="user-plus" size={15}/>{t('add')}</Button>
          </form>
          {(c.data?.customers.length ?? 0) > 1 && <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-end">
            <TextInput label={t('search')} value={search} onChange={setSearch}/>
            <SelectInput label={t('sort')} value={sort} onChange={(x) => setSort(x || 'name')} options={(['name', 'monthly', 'servers'] as const).map((k) => ({ id: k, label: t(`sortBy.${k}`) }))}/>
          </div>}
          {!list.length ? (search ? <p className="py-6 text-center text-sm text-muted">{t('noMatch')}</p> : <Empty icon={<I name="users" size={28}/>} title={t('none')}>{t('noneHelp')}</Empty>)
            : <ul className="flex flex-col gap-2">{list.map((x) => <CustomerRow key={x.id} c={x} discount={a.discountPct}/>)}</ul>}
        </div>
      </Section>
    </div>
  </>;
}
