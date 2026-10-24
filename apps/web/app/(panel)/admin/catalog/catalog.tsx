"use client";
import { Button, Card, Disclosure, Label, Meter, Modal, Tabs, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { useState } from 'react';
import { I } from '../../../../components/icon';
import { CheckboxList, ConfirmButton, DataTable, Empty, Mono, Notice, PageHeader, SelectInput, TextInput } from '../../../../components/ui';
import { apiFetch } from '../../../../lib/api';
import { useApiForm } from '../../../../lib/form';
import { useApiAction, useApiQuery } from '../../../../lib/query';

type Inventory = { compute: { moref: string; name: string; kind: string }[]; datastores: { moref: string; name: string }[]; networks: { moref: string; name: string; vlan: number | null }[]; vms: { moref: string; name: string; template: boolean }[] };
type Connection = { id: string; name: string };
type Layer = Record<string, number>;
type Capacity = { physical: Layer; headroom: Layer; offered: Layer; used: Layer; reserved: Layer; available: Layer; realFreeGb: number; warnings: string[] };
type Pool = { id: string; name: string; location: string; connectionName: string; cpuOvercommit: number; memoryOvercommit: number; storageOvercommit: number; capacity: Capacity; customRule: Record<string, unknown> | null };
type Pkg = { id: string; name: string; vcpu: number; memoryMb: number; diskGb: number; priceMonthly: string; currency: string; poolIds: string[] };
type Image = { id: string; name: string; family: string; templateName: string | null; minDiskGb: number };
type IpPool = { id: string; name: string; poolName: string; cidr: string; gateway: string; rangeStart: string; rangeEnd: string; size: number };
type Quota = { scope: string; email: string | null; maxServers: number | null; maxVcpu: number | null; maxMemoryMb: number | null; maxDiskGb: number | null };

const keys = { pools: ['catalog', 'pools'], packages: ['catalog', 'packages'], images: ['catalog', 'images'], ip: ['catalog', 'ip'], quotas: ['catalog', 'quotas'] };

// A "New ..." form in a modal; the form closes itself after a successful save.
function FormModal({ title, label, children }: { title: string; label: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button onPress={() => setOpen(true)}><I name="plus" size={16}/>{label}</Button>
    <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.CloseTrigger/>
          <Modal.Header><Modal.Heading>{title}</Modal.Heading></Modal.Header>
          <Modal.Body>{children(() => setOpen(false))}</Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </>;
}

function Submit({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return <div className="flex justify-end pt-2"><Button type="submit" isPending={busy}>{children}</Button></div>;
}

export default function Catalog() {
  const t = useTranslations('Catalog');
  const format = useFormatter();
  const [tab, setTab] = useQueryState('tab', parseAsString.withDefault('pools'));
  const pools = useApiQuery<{ pools: Pool[] }>(keys.pools, '/admin/pools').data?.pools;
  const packages = useApiQuery<{ packages: Pkg[] }>(keys.packages, '/admin/packages').data?.packages ?? [];
  const images = useApiQuery<{ images: Image[] }>(keys.images, '/admin/images').data?.images ?? [];
  const ipPools = useApiQuery<{ ipPools: IpPool[] }>(keys.ip, '/admin/ip-pools').data?.ipPools ?? [];
  const quotas = useApiQuery<{ quotas: Quota[] }>(keys.quotas, '/admin/quotas').data?.quotas ?? [];
  const connections = useApiQuery<{ connections: Connection[] }>(['vmware', 'connections'], '/admin/vmware/connections').data?.connections ?? [];
  const users = useApiQuery<{ users: { id: string; email: string }[] }>(['admin', 'users'], '/admin/users').data?.users ?? [];
  const remove = useApiAction((path: string) => apiFetch(path, { method: 'DELETE' }), { invalidate: [['catalog']], success: t('removed') });
  const removeButton = (path: string, name: string) => <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={15}/>} label={t('remove')}
    title={`${t('remove')}: ${name}`} body={t('removeConfirm', { name })} confirmLabel={t('remove')} cancelLabel={t('cancel')} onConfirm={() => remove.mutateAsync(path).then(() => undefined)}/>;
  const money = (amount: string, currency: string) => format.number(Number(amount), { style: 'currency', currency });

  if (!pools) return <><PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')}/><p role="status" className="text-sm text-muted">{t('loading')}</p></>;
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')}/>
    <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}>
      <Tabs.ListContainer>
        <Tabs.List aria-label={t('title')}>
          {(['pools', 'packages', 'images', 'ip', 'quotas'] as const).map((k) => <Tabs.Tab key={k} id={k}>{t(`${k}.title`)}<Tabs.Indicator/></Tabs.Tab>)}
        </Tabs.List>
      </Tabs.ListContainer>

      <Tabs.Panel id="pools" className="flex flex-col gap-4 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-3xl text-sm text-muted">{t('poolsExplain')}</p>
          {connections.length > 0 && <FormModal title={t('pools.new')} label={t('pools.new')}>{(close) => <PoolForm connections={connections} onSaved={close}/>}</FormModal>}
        </div>
        {!connections.length && <Notice tone="warning">{t('pools.needConnection')}</Notice>}
        {pools.length === 0 ? <Empty icon={<I name="layers" size={28}/>} title={t('pools.empty')}/>
          : <div className="grid gap-4 2xl:grid-cols-2">{pools.map((p) => <PoolCard key={p.id} pool={p} removeButton={removeButton(`/admin/pools/${p.id}`, p.name)}/>)}</div>}
      </Tabs.Panel>

      <Tabs.Panel id="packages" className="flex flex-col gap-4 pt-5">
        <div className="flex justify-end">{pools.length ? <FormModal title={t('packages.new')} label={t('packages.new')}>{(close) => <PackageForm pools={pools} images={images} onSaved={close}/>}</FormModal>
          : <p className="text-sm text-muted">{t('packages.needPool')}</p>}</div>
        <DataTable label={t('packages.title')} rows={packages} rowKey={(p) => p.id} empty={t('packages.empty')}
          columns={[{ id: 'name', label: t('col.name') }, { id: 'cpu', label: 'vCPU' }, { id: 'ram', label: 'RAM' }, { id: 'disk', label: t('col.disk') }, { id: 'price', label: t('col.price') }, { id: 'act', label: <span className="sr-only">{t('remove')}</span> }]}
          cells={(p) => [<span key="n" className="font-medium">{p.name}</span>, p.vcpu, `${p.memoryMb / 1024} GB`, `${p.diskGb} GB`, money(p.priceMonthly, p.currency), removeButton(`/admin/packages/${p.id}`, p.name)]}/>
      </Tabs.Panel>

      <Tabs.Panel id="images" className="flex flex-col gap-4 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-3xl text-sm text-muted">{t('images.explain')}</p>
          {connections.length > 0 && <FormModal title={t('images.new')} label={t('images.new')}>{(close) => <ImageForm connections={connections} onSaved={close}/>}</FormModal>}
        </div>
        <DataTable label={t('images.title')} rows={images} rowKey={(i) => i.id} empty={t('images.empty')}
          columns={[{ id: 'name', label: t('col.name') }, { id: 'family', label: t('images.family') }, { id: 'tpl', label: t('images.template') }, { id: 'disk', label: t('images.minDisk') }, { id: 'act', label: <span className="sr-only">{t('remove')}</span> }]}
          cells={(i) => [<span key="n" className="font-medium">{i.name}</span>, i.family, i.templateName ?? '–', `${i.minDiskGb} GB`, removeButton(`/admin/images/${i.id}`, i.name)]}/>
      </Tabs.Panel>

      <Tabs.Panel id="ip" className="flex flex-col gap-4 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-3xl text-sm text-muted">{t('ip.explain')}</p>
          {pools.length > 0 && <FormModal title={t('ip.new')} label={t('ip.new')}>{(close) => <IpPoolForm pools={pools} onSaved={close}/>}</FormModal>}
        </div>
        <DataTable label={t('ip.title')} rows={ipPools} rowKey={(i) => i.id} empty={t('ip.empty')} minWidth={760}
          columns={[{ id: 'name', label: t('col.name') }, { id: 'pool', label: t('ip.pool') }, { id: 'cidr', label: t('ip.subnet') }, { id: 'gw', label: t('ip.gateway') }, { id: 'range', label: t('ip.range') }, { id: 'size', label: t('ip.size') }, { id: 'act', label: <span className="sr-only">{t('remove')}</span> }]}
          cells={(i) => [<span key="n" className="font-medium">{i.name}</span>, i.poolName, <Mono key="c">{i.cidr}</Mono>, <Mono key="g">{i.gateway}</Mono>, <Mono key="r">{i.rangeStart} – {i.rangeEnd}</Mono>, i.size, removeButton(`/admin/ip-pools/${i.id}`, i.name)]}/>
      </Tabs.Panel>

      <Tabs.Panel id="quotas" className="flex flex-col gap-4 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-3xl text-sm text-muted">{t('quotas.explain')}</p>
          <FormModal title={t('quotas.set')} label={t('quotas.set')}>{(close) => <QuotaForm users={users} onSaved={close}/>}</FormModal>
        </div>
        <DataTable label={t('quotas.title')} rows={quotas} rowKey={(q) => `${q.scope}-${q.email}`}
          columns={[{ id: 'scope', label: t('quotas.scope') }, { id: 'servers', label: t('quotas.servers') }, { id: 'cpu', label: 'vCPU' }, { id: 'ram', label: 'RAM (MB)' }, { id: 'disk', label: `${t('col.disk')} (GB)` }]}
          cells={(q) => [q.scope === 'default' ? t('quotas.default') : q.email, ...[q.maxServers, q.maxVcpu, q.maxMemoryMb, q.maxDiskGb].map((v) => v ?? t('quotas.unlimited'))]}/>
      </Tabs.Panel>
    </Tabs>
  </>;
}

function PoolCard({ pool, removeButton }: { pool: Pool; removeButton: React.ReactNode }) {
  const t = useTranslations('Catalog');
  const format = useFormatter();
  const c = pool.capacity;
  const meter = (label: string, available: number, offered: number, unit: string) => {
    const usedPct = offered > 0 ? Math.min(100, Math.round(((offered - available) / offered) * 100)) : 0;
    return <Meter value={usedPct} color={usedPct > 90 ? 'danger' : usedPct > 75 ? 'warning' : 'success'} size="sm" aria-label={label}>
      <div className="flex justify-between text-xs"><Label>{label}</Label><span className="tabular-nums text-muted">{t('availableOf', { available: format.number(available), offered: format.number(offered), unit })}</span></div>
      <Meter.Track><Meter.Fill/></Meter.Track>
    </Meter>;
  };
  const row = (key: string, layer: Layer, cpu: string, mem: string, disk: string) => ({ key, cells: [t(`layer.${key as 'physical'}`), format.number(layer[cpu] ?? 0),
    `${format.number(Math.round((layer[mem] ?? 0) / 1024))} GB`, `${format.number(layer[disk] ?? 0)} GB`] });
  const rows = [row('physical', c.physical, 'cores', 'memoryMb', 'storageGb'), row('headroom', c.headroom, 'cores', 'memoryMb', 'storageGb'), row('offered', c.offered, 'vcpu', 'memoryMb', 'storageGb'),
    row('reserved', c.reserved, 'vcpu', 'memoryMb', 'diskGb'), row('used', c.used, 'vcpu', 'memoryMb', 'storageProvisionedGb'), row('available', c.available, 'vcpu', 'memoryMb', 'storageGb')];
  return <Card>
    <Card.Header className="flex flex-row items-start justify-between gap-3">
      <div className="min-w-0">
        <Card.Title className="text-base font-semibold">{pool.name} <span className="text-sm font-normal text-muted">· {pool.location || '–'} · {pool.connectionName}</span></Card.Title>
        <Card.Description className="text-xs text-muted">{t('pools.ratios', { cpu: pool.cpuOvercommit, memory: pool.memoryOvercommit, storage: pool.storageOvercommit })}</Card.Description>
      </div>
      {removeButton}
    </Card.Header>
    <Card.Content className="flex flex-col gap-4">
      <div className="grid gap-3">
        {meter('vCPU', c.available.vcpu ?? 0, c.offered.vcpu ?? 0, '')}
        {meter('RAM', Math.round((c.available.memoryMb ?? 0) / 1024), Math.round((c.offered.memoryMb ?? 0) / 1024), 'GB')}
        {meter(t('col.storage'), c.available.storageGb ?? 0, c.offered.storageGb ?? 0, 'GB')}
      </div>
      <DataTable label={`${pool.name}: ${t('capacity')}`} rows={rows} rowKey={(r) => r.key} cells={(r) => r.cells} minWidth={420}
        columns={[{ id: 'layer', label: t('capacity') }, { id: 'cpu', label: t('col.cpu') }, { id: 'ram', label: 'RAM' }, { id: 'disk', label: t('col.storage') }]}/>
      <p className="text-xs text-muted">{t('pools.storageNote', { written: c.used.storageWrittenGb, provisioned: c.used.storageProvisionedGb, free: c.realFreeGb })}</p>
      {c.warnings.map((w) => <Notice key={w} tone="warning">{t(`warning.${w as 'STORAGE_OVERPROVISIONED'}`)}</Notice>)}
      <Disclosure>
        <Disclosure.Heading><Disclosure.Trigger className="flex items-center gap-2 text-sm font-medium text-accent">{pool.customRule ? t('rule.edit') : t('rule.add')}<Disclosure.Indicator/></Disclosure.Trigger></Disclosure.Heading>
        <Disclosure.Content><Disclosure.Body className="pt-3"><RuleForm poolId={pool.id} rule={pool.customRule}/></Disclosure.Body></Disclosure.Content>
      </Disclosure>
    </Card.Content>
  </Card>;
}

function useSaved(onSaved?: () => void) {
  const client = useQueryClient();
  const t = useTranslations('Catalog');
  return async (ok: unknown) => { if (!ok) return; await client.invalidateQueries({ queryKey: ['catalog'] }); toast.success(t('saved')); onSaved?.(); };
}

function PoolForm({ connections, onSaved }: { connections: Connection[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const saved = useSaved(onSaved);
  const f = useApiForm({ name: '', location: '', connectionId: connections[0].id, computeMoref: '', networkMoref: '', cpuOvercommit: '4', memoryOvercommit: '1', storageOvercommit: '1',
    reserveCpuPct: '10', reserveMemoryPct: '10', reserveStoragePct: '15' });
  const inv = useApiQuery<Inventory>(['vmware', 'connection', f.values.connectionId], `/admin/vmware/connections/${f.values.connectionId}`).data;
  const [stores, setStores] = useState<string[]>([]);
  const num = (k: 'cpuOvercommit' | 'memoryOvercommit' | 'storageOvercommit' | 'reserveCpuPct' | 'reserveMemoryPct' | 'reserveStoragePct') =>
    <TextInput type="number" label={t(`pools.${k}`)} help={t(`pools.${k}Help`)} value={f.values[k]} onChange={f.set(k)} error={f.fieldError(k)}/>;
  return <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => { e.preventDefault(); saved(await f.submit('POST', '/admin/pools', { ...f.values, datastoreMorefs: stores })); }}>
    <div className="grid gap-4 sm:grid-cols-2">
      <TextInput label={t('col.name')} value={f.values.name} onChange={f.set('name')} error={f.fieldError('name')}/>
      <TextInput label={t('pools.location')} help={t('pools.locationHelp')} value={f.values.location} onChange={f.set('location')}/>
      <SelectInput label={t('pools.connection')} value={f.values.connectionId} onChange={f.set('connectionId')} options={connections.map((c) => ({ id: c.id, label: c.name }))}/>
      <SelectInput label={t('pools.compute')} value={f.values.computeMoref} onChange={f.set('computeMoref')} error={f.fieldError('computeMoref')}
        options={inv?.compute.map((c) => ({ id: c.moref, label: `${c.name} (${c.kind})` })) ?? []}/>
      <SelectInput label={t('pools.network')} value={f.values.networkMoref} onChange={f.set('networkMoref')} error={f.fieldError('networkMoref')}
        options={inv?.networks.map((n) => ({ id: n.moref, label: `${n.name}${n.vlan !== null ? ` (VLAN ${n.vlan})` : ''}` })) ?? []}/>
    </div>
    <CheckboxList label={t('pools.datastores')} value={stores} onChange={setStores} error={f.fieldError('datastoreMorefs')} options={inv?.datastores.map((d) => ({ id: d.moref, label: d.name })) ?? []}/>
    <div className="grid gap-4 sm:grid-cols-3">{num('cpuOvercommit')}{num('memoryOvercommit')}{num('storageOvercommit')}</div>
    <div className="grid gap-4 sm:grid-cols-3">{num('reserveCpuPct')}{num('reserveMemoryPct')}{num('reserveStoragePct')}</div>
    {f.failure && <p role="alert" className="text-sm text-danger">{f.failure.text}</p>}
    <Submit busy={f.busy}>{t('pools.create')}</Submit>
  </form>;
}

const ruleKeys = ['cpuMin', 'cpuMax', 'cpuStep', 'memoryMinMb', 'memoryMaxMb', 'memoryStepMb', 'diskMinGb', 'diskMaxGb', 'diskStepGb', 'minMemoryMbPerVcpu', 'maxMemoryMbPerVcpu', 'priceVcpu', 'priceMemoryGb', 'priceDiskGb', 'currency'] as const;
const ruleColumns: Record<(typeof ruleKeys)[number], string> = { cpuMin: 'cpu_min', cpuMax: 'cpu_max', cpuStep: 'cpu_step', memoryMinMb: 'memory_min_mb', memoryMaxMb: 'memory_max_mb',
  memoryStepMb: 'memory_step_mb', diskMinGb: 'disk_min_gb', diskMaxGb: 'disk_max_gb', diskStepGb: 'disk_step_gb', minMemoryMbPerVcpu: 'min_memory_mb_per_vcpu',
  maxMemoryMbPerVcpu: 'max_memory_mb_per_vcpu', priceVcpu: 'price_vcpu', priceMemoryGb: 'price_memory_gb', priceDiskGb: 'price_disk_gb', currency: 'currency' };
const ruleDefaults = { cpuMin: '1', cpuMax: '16', cpuStep: '1', memoryMinMb: '1024', memoryMaxMb: '65536', memoryStepMb: '1024', diskMinGb: '20', diskMaxGb: '1000', diskStepGb: '10',
  minMemoryMbPerVcpu: '1024', maxMemoryMbPerVcpu: '8192', priceVcpu: '', priceMemoryGb: '', priceDiskGb: '', currency: 'EUR' };

function RuleForm({ poolId, rule }: { poolId: string; rule: Record<string, unknown> | null }) {
  const t = useTranslations('Catalog');
  const saved = useSaved();
  const f = useApiForm(Object.fromEntries(ruleKeys.map((k) => [k, rule ? String(rule[ruleColumns[k]]) : ruleDefaults[k]])) as Record<(typeof ruleKeys)[number], string>);
  return <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => { e.preventDefault(); saved(await f.submit('PUT', `/admin/pools/${poolId}/custom-rule`)); }}>
    <p className="text-sm text-muted">{t('rule.explain')}</p>
    <div className="grid gap-4 sm:grid-cols-3">{ruleKeys.map((k) => <TextInput key={k} label={t(`rule.${k}`)} value={f.values[k]} onChange={f.set(k)} error={f.fieldError(k)}/>)}</div>
    {f.failure && <p role="alert" className="text-sm text-danger">{f.failure.text}</p>}
    <Submit busy={f.busy}>{t('rule.save')}</Submit>
  </form>;
}

function ImageForm({ connections, onSaved }: { connections: Connection[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const saved = useSaved(onSaved);
  const f = useApiForm({ name: '', family: 'linux', connectionId: connections[0]?.id ?? '', templateMoref: '', minDiskGb: '20' });
  const vms = useApiQuery<Inventory>(['vmware', 'connection', f.values.connectionId], f.values.connectionId ? `/admin/vmware/connections/${f.values.connectionId}` : null).data?.vms.filter((v) => v.template) ?? [];
  return <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => { e.preventDefault(); saved(await f.submit('POST', '/admin/images')); }}>
    <div className="grid gap-4 sm:grid-cols-2">
      <TextInput label={t('col.name')} value={f.values.name} onChange={f.set('name')} error={f.fieldError('name')}/>
      <SelectInput label={t('images.family')} value={f.values.family} onChange={f.set('family')} options={[{ id: 'linux', label: 'Linux' }, { id: 'windows', label: 'Windows' }]}/>
      <SelectInput label={t('pools.connection')} value={f.values.connectionId} onChange={f.set('connectionId')} options={connections.map((c) => ({ id: c.id, label: c.name }))}/>
      <SelectInput label={t('images.template')} value={f.values.templateMoref} onChange={f.set('templateMoref')} error={f.fieldError('templateMoref')}
        help={vms.length ? undefined : t('images.noTemplates')} options={vms.map((v) => ({ id: v.moref, label: v.name }))}/>
      <TextInput type="number" label={t('images.minDisk')} value={f.values.minDiskGb} onChange={f.set('minDiskGb')} error={f.fieldError('minDiskGb')}/>
    </div>
    {f.failure && <p role="alert" className="text-sm text-danger">{f.failure.text}</p>}
    <Submit busy={f.busy}>{t('images.create')}</Submit>
  </form>;
}

function PackageForm({ pools, images, onSaved }: { pools: Pool[]; images: Image[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const saved = useSaved(onSaved);
  const f = useApiForm({ name: '', vcpu: '2', memoryMb: '4096', diskGb: '40', priceMonthly: '', priceHourly: '', currency: 'EUR' });
  const [poolIds, setPoolIds] = useState<string[]>([]);
  const [imageIds, setImageIds] = useState<string[]>([]);
  return <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => { e.preventDefault(); saved(await f.submit('POST', '/admin/packages', { ...f.values, poolIds, imageIds })); }}>
    <TextInput label={t('col.name')} value={f.values.name} onChange={f.set('name')} error={f.fieldError('name')}/>
    <div className="grid gap-4 sm:grid-cols-3">
      <TextInput type="number" label="vCPU" value={f.values.vcpu} onChange={f.set('vcpu')} error={f.fieldError('vcpu')}/>
      <TextInput type="number" label="RAM (MB)" value={f.values.memoryMb} onChange={f.set('memoryMb')} error={f.fieldError('memoryMb')}/>
      <TextInput type="number" label={`${t('col.disk')} (GB)`} value={f.values.diskGb} onChange={f.set('diskGb')} error={f.fieldError('diskGb')}/>
      <TextInput label={t('packages.priceMonthly')} value={f.values.priceMonthly} onChange={f.set('priceMonthly')} error={f.fieldError('priceMonthly')}/>
      <TextInput label={t('packages.priceHourly')} value={f.values.priceHourly} onChange={f.set('priceHourly')} error={f.fieldError('priceHourly')}/>
      <TextInput label={t('packages.currency')} help={t('packages.currencyHelp')} value={f.values.currency} onChange={f.set('currency')} error={f.fieldError('currency')} maxLength={3}/>
    </div>
    <CheckboxList label={t('packages.pools')} value={poolIds} onChange={setPoolIds} error={f.fieldError('poolIds')} options={pools.map((p) => ({ id: p.id, label: p.name }))}/>
    <CheckboxList label={t('packages.images')} value={imageIds} onChange={setImageIds} options={images.map((i) => ({ id: i.id, label: i.name }))}/>
    {f.failure && <p role="alert" className="text-sm text-danger">{f.failure.text}</p>}
    <Submit busy={f.busy}>{t('packages.create')}</Submit>
  </form>;
}

function IpPoolForm({ pools, onSaved }: { pools: Pool[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const saved = useSaved(onSaved);
  const f = useApiForm({ name: '', poolId: pools[0].id, cidr: '', gateway: '', rangeStart: '', rangeEnd: '', dns: '', excluded: '' });
  const list = (s: string) => s.split(/[\s,]+/).filter(Boolean);
  return <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => { e.preventDefault(); saved(await f.submit('POST', '/admin/ip-pools', { ...f.values, dns: list(f.values.dns), excluded: list(f.values.excluded) })); }}>
    <div className="grid gap-4 sm:grid-cols-2">
      <TextInput label={t('col.name')} value={f.values.name} onChange={f.set('name')} error={f.fieldError('name')}/>
      <SelectInput label={t('ip.pool')} value={f.values.poolId} onChange={f.set('poolId')} options={pools.map((p) => ({ id: p.id, label: p.name }))}/>
      <TextInput label={t('ip.subnet')} help="203.0.113.0/24" value={f.values.cidr} onChange={f.set('cidr')} error={f.fieldError('cidr')} spellCheck={false}/>
      <TextInput label={t('ip.gateway')} value={f.values.gateway} onChange={f.set('gateway')} error={f.fieldError('gateway')} spellCheck={false}/>
      <TextInput label={t('ip.start')} value={f.values.rangeStart} onChange={f.set('rangeStart')} error={f.fieldError('range')} spellCheck={false}/>
      <TextInput label={t('ip.end')} value={f.values.rangeEnd} onChange={f.set('rangeEnd')} spellCheck={false}/>
      <TextInput label="DNS" help={t('ip.listHelp')} value={f.values.dns} onChange={f.set('dns')} spellCheck={false}/>
      <TextInput label={t('ip.excluded')} help={t('ip.listHelp')} value={f.values.excluded} onChange={f.set('excluded')} spellCheck={false}/>
    </div>
    {f.failure && <p role="alert" className="text-sm text-danger">{f.failure.text}</p>}
    <Submit busy={f.busy}>{t('ip.create')}</Submit>
  </form>;
}

function QuotaForm({ users, onSaved }: { users: { id: string; email: string }[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const saved = useSaved(onSaved);
  const f = useApiForm({ subject: 'default', maxServers: '', maxVcpu: '', maxMemoryMb: '', maxDiskGb: '' });
  const value = (s: string) => (s === '' ? null : Number(s));
  return <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => { e.preventDefault();
    const body = { maxServers: value(f.values.maxServers), maxVcpu: value(f.values.maxVcpu), maxMemoryMb: value(f.values.maxMemoryMb), maxDiskGb: value(f.values.maxDiskGb) };
    saved(await f.submit('PUT', f.values.subject === 'default' ? '/admin/quotas/default' : `/admin/quotas/users/${f.values.subject}`, body)); }}>
    <SelectInput label={t('quotas.scope')} value={f.values.subject} onChange={f.set('subject')} options={[{ id: 'default', label: t('quotas.default') }, ...users.map((u) => ({ id: u.id, label: u.email }))]}/>
    <div className="grid gap-4 sm:grid-cols-2">{(['maxServers', 'maxVcpu', 'maxMemoryMb', 'maxDiskGb'] as const).map((k) =>
      <TextInput key={k} type="number" label={t(`quotas.${k}`)} help={t('quotas.emptyUnlimited')} value={f.values[k]} onChange={f.set(k)} error={f.fieldError(k)}/>)}</div>
    {f.failure && <p role="alert" className="text-sm text-danger">{f.failure.text}</p>}
    <Submit busy={f.busy}>{t('quotas.save')}</Submit>
  </form>;
}
