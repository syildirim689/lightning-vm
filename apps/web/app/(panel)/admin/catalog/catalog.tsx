"use client";
import { Button, Card, Disclosure, Label, Meter, Modal, Tabs, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { useState } from 'react';
import { I } from '../../../../components/icon';
import { CheckboxList, ConfirmButton, DataTable, Empty, FieldGroup, Mono, Notice, NumberInput, PageHeader, SelectInput, TextInput } from '../../../../components/ui';
import { apiFetch } from '../../../../lib/api';
import { useApiForm } from '../../../../lib/form';
import { useApiAction, useApiQuery } from '../../../../lib/query';
import { sellable } from '../../../../lib/sizing';
import { Applications } from './apps-ui';
import { IsoLibrary } from './iso-ui';
import { flag, Locations, PoolLocation, useLocations } from './locations-ui';
import { VdcAdmin } from './vdc-ui';
import { IpAddresses, IpPoolEdit, PoolIpOptions, type IpPoolRow } from './ip-ui';

type Inventory = { compute: { moref: string; name: string; kind: string }[]; datastores: { moref: string; name: string }[]; networks: { moref: string; name: string; vlan: number | null }[]; vms: { moref: string; name: string; template: boolean }[] };
type Connection = { id: string; name: string };
type Layer = Record<string, number>;
type Capacity = { physical: Layer; headroom: Layer; offered: Layer; used: Layer; reserved: Layer; available: Layer; realFreeGb: number; warnings: string[] };
type Pool = { id: string; name: string; location: string; locationId: string | null; connectionName: string; cpuOvercommit: number; memoryOvercommit: number; storageOvercommit: number; capacity: Capacity; customRule: Record<string, unknown> | null;
  extraIpv4Max: number; extraIpv4Price: string; trafficGb: number | null };
type Pkg = { id: string; name: string; vcpu: number; memoryMb: number; diskGb: number; priceMonthly: string; currency: string; poolIds: string[]; trafficGb: number | null };
type Image = { id: string; name: string; family: string; templateName: string | null; minDiskGb: number };
type IpPool = IpPoolRow;
type Quota = { scope: string; email: string | null; maxServers: number | null; maxVcpu: number | null; maxMemoryMb: number | null; maxDiskGb: number | null };

const keys = { pools: ['catalog', 'pools'], packages: ['catalog', 'packages'], images: ['catalog', 'images'], ip: ['catalog', 'ip'], quotas: ['catalog', 'quotas'] };

// A "New ..." form in a modal; the form closes itself after a successful save.
function FormModal({ title, label, children }: { title: string; label: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button onPress={() => setOpen(true)}><I name="plus" size={16}/>{label}</Button>
    <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog className="sm:max-w-3xl">
          <Modal.CloseTrigger/>
          <Modal.Header><Modal.Heading>{title}</Modal.Heading></Modal.Header>
          <Modal.Body>{children(() => setOpen(false))}</Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </>;
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
      <Tabs.ListContainer className="overflow-x-auto">
        <Tabs.List aria-label={t('title')}>
          {(['locations', 'pools', 'packages', 'images', 'isos', 'ip', 'apps', 'vdcs', 'quotas'] as const).map((k) => <Tabs.Tab key={k} id={k} className="whitespace-nowrap">{t(`${k}.title`)}<Tabs.Indicator/></Tabs.Tab>)}
        </Tabs.List>
      </Tabs.ListContainer>

      <Tabs.Panel id="locations" className="flex flex-col gap-4 pt-5"><Locations/></Tabs.Panel>

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
          columns={[{ id: 'name', label: t('col.name') }, { id: 'cpu', label: 'vCPU' }, { id: 'ram', label: 'RAM' }, { id: 'disk', label: t('col.disk') }, { id: 'price', label: t('col.price') }, { id: 'sell', label: t('packages.sellable') }, { id: 'act', label: <span className="sr-only">{t('remove')}</span> }]}
          cells={(p) => [<span key="n" className="flex flex-col"><span className="font-medium">{p.name}</span><span className="text-xs text-muted">{p.trafficGb ? t('packages.trafficShort', { gb: p.trafficGb }) : t('packages.unlimited')}</span></span>, p.vcpu, `${p.memoryMb / 1024} GB`, `${p.diskGb} GB`, money(p.priceMonthly, p.currency), <Sellable key="s" pkg={p} pools={pools}/>, removeButton(`/admin/packages/${p.id}`, p.name)]}/>
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
          columns={[{ id: 'name', label: t('col.name') }, { id: 'pool', label: t('ip.pool') }, { id: 'cidr', label: t('ip.subnet') }, { id: 'gw', label: t('ip.gateway') }, { id: 'range', label: t('ip.range') },
            { id: 'size', label: t('ipm.usage') }, { id: 'v6', label: 'IPv6' }, { id: 'act', label: <span className="sr-only">{t('remove')}</span> }]}
          cells={(i) => [<span key="n" className="font-medium">{i.name}</span>, i.poolName, <Mono key="c">{i.cidr}</Mono>, <Mono key="g">{i.gateway}</Mono>, <Mono key="r">{i.rangeStart} – {i.rangeEnd}</Mono>,
            <span key="u" className="flex flex-col text-sm"><span className="tabular-nums">{t('ipm.usageOf', { used: i.used, size: i.size })}</span>{i.quarantined > 0 && <span className="text-xs text-warning">{t('ipm.inQuarantine', { n: i.quarantined })}</span>}<span className="text-xs text-muted">{t('ipm.quarantineFor', { h: i.quarantineHours })}</span></span>,
            i.ipv6Prefix ? <Mono key="v6">{i.ipv6Prefix}</Mono> : '–',
            <span key="a" className="flex gap-1"><IpPoolEdit ipPool={i}/>{removeButton(`/admin/ip-pools/${i.id}`, i.name)}</span>]}/>
        <IpAddresses ipPools={ipPools}/>
      </Tabs.Panel>

      <Tabs.Panel id="isos" className="flex flex-col gap-4 pt-5">
        <IsoLibrary pools={pools.map((p) => ({ id: p.id, name: p.location ? `${p.name} · ${p.location}` : p.name }))}/>
      </Tabs.Panel>

      <Tabs.Panel id="apps" className="flex flex-col gap-4 pt-5">
        <Applications currency={packages[0]?.currency ?? 'EUR'}/>
      </Tabs.Panel>

      <Tabs.Panel id="vdcs" className="flex flex-col gap-4 pt-5"><VdcAdmin pools={pools.map((p) => ({ id: p.id, name: p.location ? `${p.name} · ${p.location}` : p.name }))}/></Tabs.Panel>

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
      <PoolLocation poolId={pool.id} locationId={pool.locationId}/>
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
      <Disclosure>
        <Disclosure.Heading><Disclosure.Trigger className="flex items-center gap-2 text-sm font-medium text-accent">{t('ipm.extraTitle', { n: pool.extraIpv4Max })}<Disclosure.Indicator/></Disclosure.Trigger></Disclosure.Heading>
        <Disclosure.Content><Disclosure.Body className="pt-3"><PoolIpOptions pool={pool}/></Disclosure.Body></Disclosure.Content>
      </Disclosure>
    </Card.Content>
  </Card>;
}

function useSaved(onSaved?: () => void) {
  const client = useQueryClient();
  const t = useTranslations('Catalog');
  return async (ok: unknown) => { if (!ok) return; await client.invalidateQueries({ queryKey: ['catalog'] }); toast.success(t('saved')); onSaved?.(); };
}

// The error banner and the action bar every catalog form ends with (sticky at the bottom of the dialog).
function FormFooter({ failure, busy, label, onCancel }: { failure?: string; busy: boolean; label: string; onCancel?: () => void }) {
  const t = useTranslations('Catalog');
  return <>
    {failure && <div role="alert"><Notice tone="danger">{failure}</Notice></div>}
    <div className="sticky bottom-0 -mx-1 flex flex-wrap justify-end gap-2 border-t border-separator bg-overlay px-1 py-3">
      {onCancel && <Button variant="tertiary" onPress={onCancel}>{t('cancel')}</Button>}
      <Button type="submit" isPending={busy}><I name="check" size={16}/>{label}</Button>
    </div>
  </>;
}
const num = (v: string) => (v === '' ? undefined : Number(v));
const str = (v: number | undefined) => (v === undefined ? '' : String(v));

function PoolForm({ connections, onSaved }: { connections: Connection[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const saved = useSaved(onSaved);
  const locations = useLocations();
  const f = useApiForm({ name: '', locationId: '', connectionId: connections[0].id, computeMoref: '', networkMoref: '', cpuOvercommit: '4', memoryOvercommit: '1', storageOvercommit: '1',
    reserveCpuPct: '10', reserveMemoryPct: '10', reserveStoragePct: '15' });
  const inv = useApiQuery<Inventory>(['vmware', 'connection', f.values.connectionId], `/admin/vmware/connections/${f.values.connectionId}`).data;
  const [stores, setStores] = useState<string[]>([]);
  const ratio = (k: 'cpuOvercommit' | 'memoryOvercommit' | 'storageOvercommit', max: number) =>
    <NumberInput label={t(`pools.${k}`)} help={t(`pools.${k}Help`)} value={num(f.values[k])} onChange={(v) => f.set(k)(str(v))} minValue={1} maxValue={max} step={0.5} error={f.fieldError(k)}
      formatOptions={{ maximumFractionDigits: 2, style: 'decimal' }}/>;
  const pct = (k: 'reserveCpuPct' | 'reserveMemoryPct' | 'reserveStoragePct') =>
    <NumberInput label={t(`pools.${k}`)} value={num(f.values[k]) !== undefined ? num(f.values[k])! / 100 : undefined} onChange={(v) => f.set(k)(str(v === undefined ? undefined : Math.round(v * 100)))}
      minValue={0} maxValue={0.9} step={0.05} error={f.fieldError(k)} formatOptions={{ style: 'percent' }}/>;
  return <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => { e.preventDefault(); saved(await f.submit('POST', '/admin/pools', { ...f.values, datastoreMorefs: stores })); }}>
    <FieldGroup title={t('form.identity')} description={t('form.poolIdentityHelp')}>
      <TextInput label={t('col.name')} value={f.values.name} onChange={f.set('name')} error={f.fieldError('name')} isRequired placeholder="Istanbul-1"/>
      <SelectInput label={t('pools.location')} help={t('pools.locationHelp')} value={f.values.locationId} onChange={f.set('locationId')} error={f.fieldError('locationId')}
        options={[{ id: '', label: '–' }, ...locations.map((l) => ({ id: l.id, label: `${flag(l.countryCode)} ${l.name}`.trim(), description: [l.city, l.datacenter].filter(Boolean).join(' · ') || undefined }))]}/>
    </FieldGroup>
    <FieldGroup title={t('form.vmware')} description={t('form.vmwareHelp')}>
      <SelectInput label={t('pools.connection')} value={f.values.connectionId} onChange={f.set('connectionId')} options={connections.map((c) => ({ id: c.id, label: c.name }))}/>
      <SelectInput label={t('pools.compute')} value={f.values.computeMoref} onChange={f.set('computeMoref')} error={f.fieldError('computeMoref')}
        options={inv?.compute.map((c) => ({ id: c.moref, label: c.name, description: c.kind })) ?? []}/>
      <SelectInput className="sm:col-span-2" label={t('pools.network')} value={f.values.networkMoref} onChange={f.set('networkMoref')} error={f.fieldError('networkMoref')}
        options={inv?.networks.map((n) => ({ id: n.moref, label: n.name, description: n.vlan !== null ? `VLAN ${n.vlan}` : undefined })) ?? []}/>
      <div className="sm:col-span-2"><CheckboxList label={t('pools.datastores')} value={stores} onChange={setStores} error={f.fieldError('datastoreMorefs')} help={t('form.datastoresHelp')}
        options={inv?.datastores.map((d) => ({ id: d.moref, label: d.name })) ?? []}/></div>
    </FieldGroup>
    <FieldGroup title={t('form.overcommit')} description={t('form.overcommitHelp')} cols={3}>{ratio('cpuOvercommit', 32)}{ratio('memoryOvercommit', 4)}{ratio('storageOvercommit', 10)}</FieldGroup>
    <FieldGroup title={t('form.reserve')} description={t('form.reserveHelp')} cols={3}>{pct('reserveCpuPct')}{pct('reserveMemoryPct')}{pct('reserveStoragePct')}</FieldGroup>
    <FormFooter failure={f.failure?.text} busy={f.busy} label={t('pools.create')} onCancel={onSaved}/>
  </form>;
}

const ruleKeys = ['cpuMin', 'cpuMax', 'cpuStep', 'memoryMinMb', 'memoryMaxMb', 'memoryStepMb', 'diskMinGb', 'diskMaxGb', 'diskStepGb', 'minMemoryMbPerVcpu', 'maxMemoryMbPerVcpu', 'priceVcpu', 'priceMemoryGb', 'priceDiskGb', 'currency'] as const;
const ruleColumns: Record<(typeof ruleKeys)[number], string> = { cpuMin: 'cpu_min', cpuMax: 'cpu_max', cpuStep: 'cpu_step', memoryMinMb: 'memory_min_mb', memoryMaxMb: 'memory_max_mb',
  memoryStepMb: 'memory_step_mb', diskMinGb: 'disk_min_gb', diskMaxGb: 'disk_max_gb', diskStepGb: 'disk_step_gb', minMemoryMbPerVcpu: 'min_memory_mb_per_vcpu',
  maxMemoryMbPerVcpu: 'max_memory_mb_per_vcpu', priceVcpu: 'price_vcpu', priceMemoryGb: 'price_memory_gb', priceDiskGb: 'price_disk_gb', currency: 'currency' };
const ruleDefaults = { cpuMin: '1', cpuMax: '16', cpuStep: '1', memoryMinMb: '1024', memoryMaxMb: '65536', memoryStepMb: '1024', diskMinGb: '20', diskMaxGb: '1000', diskStepGb: '10',
  minMemoryMbPerVcpu: '1024', maxMemoryMbPerVcpu: '8192', priceVcpu: '', priceMemoryGb: '', priceDiskGb: '', currency: 'EUR' };
const currencies = ['EUR', 'USD', 'TRY', 'GBP'];

function RuleForm({ poolId, rule }: { poolId: string; rule: Record<string, unknown> | null }) {
  const t = useTranslations('Catalog');
  const saved = useSaved();
  const f = useApiForm(Object.fromEntries(ruleKeys.map((k) => [k, rule ? String(rule[ruleColumns[k]]) : ruleDefaults[k]])) as Record<(typeof ruleKeys)[number], string>);
  // Memory is entered in GB here and stored in MB.
  const field = (k: (typeof ruleKeys)[number], gb = false) => <NumberInput key={k} label={t(`rule.${k}`)} error={f.fieldError(k)} minValue={0}
    value={num(f.values[k]) !== undefined ? (gb ? num(f.values[k])! / 1024 : num(f.values[k])) : undefined} step={gb ? 0.5 : 1}
    onChange={(v) => f.set(k)(str(v === undefined ? undefined : gb ? Math.round(v * 1024) : v))}/>;
  const money = (k: 'priceVcpu' | 'priceMemoryGb' | 'priceDiskGb') => <TextInput key={k} label={t(`rule.${k}`)} value={f.values[k]} onChange={f.set(k)} error={f.fieldError(k)} placeholder="0.00"/>;
  return <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => { e.preventDefault(); saved(await f.submit('PUT', `/admin/pools/${poolId}/custom-rule`)); }}>
    <p className="text-sm text-muted">{t('rule.explain')}</p>
    <FieldGroup title={t('form.cpuRange')} cols={3}>{field('cpuMin')}{field('cpuMax')}{field('cpuStep')}</FieldGroup>
    <FieldGroup title={t('form.memoryRange')} cols={3}>{field('memoryMinMb', true)}{field('memoryMaxMb', true)}{field('memoryStepMb', true)}</FieldGroup>
    <FieldGroup title={t('form.diskRange')} cols={3}>{field('diskMinGb')}{field('diskMaxGb')}{field('diskStepGb')}</FieldGroup>
    <FieldGroup title={t('form.balance')} description={t('form.balanceHelp')}>{field('minMemoryMbPerVcpu', true)}{field('maxMemoryMbPerVcpu', true)}</FieldGroup>
    <FieldGroup title={t('form.pricing')} description={t('form.pricingHelp')} cols={3}>
      {money('priceVcpu')}{money('priceMemoryGb')}{money('priceDiskGb')}
      <SelectInput label={t('packages.currency')} value={f.values.currency} onChange={f.set('currency')} options={currencies.map((c) => ({ id: c, label: c }))}/>
    </FieldGroup>
    <FormFooter failure={f.failure?.text} busy={f.busy} label={t('rule.save')}/>
  </form>;
}

function ImageForm({ connections, onSaved }: { connections: Connection[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const saved = useSaved(onSaved);
  const f = useApiForm({ name: '', family: 'linux', connectionId: connections[0]?.id ?? '', templateMoref: '', minDiskGb: '20' });
  const vms = useApiQuery<Inventory>(['vmware', 'connection', f.values.connectionId], f.values.connectionId ? `/admin/vmware/connections/${f.values.connectionId}` : null).data?.vms.filter((v) => v.template) ?? [];
  return <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => { e.preventDefault(); saved(await f.submit('POST', '/admin/images')); }}>
    <FieldGroup title={t('form.identity')} description={t('form.imageIdentityHelp')}>
      <TextInput label={t('col.name')} value={f.values.name} onChange={f.set('name')} error={f.fieldError('name')} isRequired placeholder="Ubuntu 24.04 LTS"/>
      <SelectInput label={t('images.family')} value={f.values.family} onChange={f.set('family')} options={[{ id: 'linux', label: 'Linux' }, { id: 'windows', label: 'Windows' }, { id: 'esxi', label: t('images.esxi'), description: t('images.esxiHelp') }]}/>
    </FieldGroup>
    <FieldGroup title={t('form.template')} description={t('form.templateHelp')}>
      <SelectInput label={t('pools.connection')} value={f.values.connectionId} onChange={f.set('connectionId')} options={connections.map((c) => ({ id: c.id, label: c.name }))}/>
      <SelectInput label={t('images.template')} value={f.values.templateMoref} onChange={f.set('templateMoref')} error={f.fieldError('templateMoref')}
        help={vms.length ? undefined : t('images.noTemplates')} options={vms.map((v) => ({ id: v.moref, label: v.name }))}/>
    </FieldGroup>
    <FieldGroup title={t('form.requirements')} cols={1}>
      <NumberInput label={t('images.minDisk')} value={num(f.values.minDiskGb)} onChange={(v) => f.set('minDiskGb')(str(v))} minValue={1} maxValue={65536} error={f.fieldError('minDiskGb')} help={t('form.minDiskHelp')}/>
    </FieldGroup>
    <FormFooter failure={f.failure?.text} busy={f.busy} label={t('images.create')} onCancel={onSaved}/>
  </form>;
}

function PackageForm({ pools, images, onSaved }: { pools: Pool[]; images: Image[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const format = useFormatter();
  const saved = useSaved(onSaved);
  const f = useApiForm({ name: '', vcpu: '2', memoryMb: '4096', diskGb: '40', trafficGb: '', priceMonthly: '', priceHourly: '', currency: 'EUR' });
  const [poolIds, setPoolIds] = useState<string[]>(pools.length === 1 ? [pools[0].id] : []);
  const [imageIds, setImageIds] = useState<string[]>([]);
  const price = Number(f.values.priceMonthly.replace(',', '.'));
  // Hourly price suggested from the monthly one (730 hours), unless the admin typed their own.
  const hourly = Number.isFinite(price) && price > 0 ? (price / 730).toFixed(4) : '';
  const tooSmall = images.filter((i) => imageIds.includes(i.id) && i.minDiskGb > Number(f.values.diskGb));
  return <form className="flex flex-col gap-4" noValidate
    onSubmit={async (e) => { e.preventDefault(); saved(await f.submit('POST', '/admin/packages', { ...f.values, priceMonthly: f.values.priceMonthly.replace(',', '.'), priceHourly: (f.values.priceHourly || hourly).replace(',', '.'), poolIds, imageIds })); }}>
    <FieldGroup title={t('form.identity')} cols={1}>
      <TextInput label={t('col.name')} value={f.values.name} onChange={f.set('name')} error={f.fieldError('name')} isRequired placeholder="Standard 2"/>
    </FieldGroup>
    <FieldGroup title={t('form.resources')} description={t('form.resourcesHelp')} cols={3}>
      <NumberInput label="vCPU" value={num(f.values.vcpu)} onChange={(v) => f.set('vcpu')(str(v))} minValue={1} maxValue={256} error={f.fieldError('vcpu')}/>
      <NumberInput label="RAM (GB)" value={num(f.values.memoryMb) !== undefined ? num(f.values.memoryMb)! / 1024 : undefined} step={0.5} minValue={0.5}
        onChange={(v) => f.set('memoryMb')(str(v === undefined ? undefined : Math.round(v * 1024)))} error={f.fieldError('memoryMb')}/>
      <NumberInput label={`${t('col.disk')} (GB)`} value={num(f.values.diskGb)} onChange={(v) => f.set('diskGb')(str(v))} minValue={1} maxValue={65536} step={10} error={f.fieldError('diskGb')}/>
      <NumberInput label={t('packages.traffic')} value={num(f.values.trafficGb)} onChange={(v) => f.set('trafficGb')(str(v))} minValue={1} step={100} error={f.fieldError('trafficGb')} help={t('packages.trafficHelp')}/>
    </FieldGroup>
    <FieldGroup title={t('form.pricing')} cols={3}>
      <TextInput label={t('packages.priceMonthly')} value={f.values.priceMonthly} onChange={f.set('priceMonthly')} error={f.fieldError('priceMonthly')} placeholder="9.90"/>
      <TextInput label={t('packages.priceHourly')} value={f.values.priceHourly} onChange={f.set('priceHourly')} error={f.fieldError('priceHourly')} placeholder={hourly || '0.0136'} help={t('form.hourlyHelp')}/>
      <SelectInput label={t('packages.currency')} value={f.values.currency} onChange={f.set('currency')} options={currencies.map((c) => ({ id: c, label: c }))} error={f.fieldError('currency')}/>
    </FieldGroup>
    <FieldGroup title={t('form.where')} description={t('form.whereHelp')} cols={1}>
      <CheckboxList label={t('packages.pools')} value={poolIds} onChange={setPoolIds} error={f.fieldError('poolIds')} options={pools.map((p) => ({ id: p.id, label: p.name }))}/>
      <CheckboxList label={t('packages.images')} value={imageIds} onChange={setImageIds} options={images.map((i) => ({ id: i.id, label: `${i.name} (≥ ${i.minDiskGb} GB)` }))}/>
      {tooSmall.length > 0 && <Notice tone="warning">{t('form.diskTooSmall', { images: tooSmall.map((i) => i.name).join(', ') })}</Notice>}
    </FieldGroup>
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 text-sm" aria-live="polite">
      <I name="package" size={18} className="text-accent"/>
      <span className="font-semibold">{f.values.name || t('form.preview')}</span>
      <span className="text-muted">{t('form.previewShape', { vcpu: f.values.vcpu || 0, memory: format.number(Number(f.values.memoryMb || 0) / 1024, { maximumFractionDigits: 1 }), disk: f.values.diskGb || 0 })}</span>
      {price > 0 && <span className="ml-auto font-semibold tabular-nums">{format.number(price, { style: 'currency', currency: f.values.currency })} / {t('form.month')}</span>}
    </div>
    <FormFooter failure={f.failure?.text} busy={f.busy} label={t('packages.create')} onCancel={onSaved}/>
  </form>;
}

// From "203.0.113.0/24": gateway .1, usable range .2 – .254 (IPv4 only).
function cidrSuggest(cidr: string) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m || m.slice(1, 5).some((x) => Number(x) > 255) || Number(m[5]) < 16 || Number(m[5]) > 30) return null;
  const ip = m.slice(1, 5).reduce((a, x) => a * 256 + Number(x), 0);
  const size = 2 ** (32 - Number(m[5]));
  const net = ip - (ip % size);
  const dot = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
  return { gateway: dot(net + 1), start: dot(net + 2), end: dot(net + size - 2), usable: size - 3 };
}

function IpPoolForm({ pools, onSaved }: { pools: Pool[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const saved = useSaved(onSaved);
  const f = useApiForm({ name: '', poolId: pools[0].id, cidr: '', gateway: '', rangeStart: '', rangeEnd: '', dns: '1.1.1.1, 8.8.8.8', excluded: '', quarantineHours: '24', ipv6Prefix: '', ipv6Gateway: '' });
  const list = (s: string) => s.split(/[\s,]+/).filter(Boolean);
  const hint = cidrSuggest(f.values.cidr);
  const fill = () => hint && f.setValues((v) => ({ ...v, gateway: hint.gateway, rangeStart: hint.start, rangeEnd: hint.end }));
  return <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => { e.preventDefault(); saved(await f.submit('POST', '/admin/ip-pools', { ...f.values, dns: list(f.values.dns), excluded: list(f.values.excluded) })); }}>
    <FieldGroup title={t('form.identity')}>
      <TextInput label={t('col.name')} value={f.values.name} onChange={f.set('name')} error={f.fieldError('name')} isRequired placeholder="Public v4"/>
      <SelectInput label={t('ip.pool')} value={f.values.poolId} onChange={f.set('poolId')} options={pools.map((p) => ({ id: p.id, label: p.name }))}/>
    </FieldGroup>
    <FieldGroup title={t('form.network')} description={t('form.networkHelp')}>
      <TextInput label={t('ip.subnet')} help="203.0.113.0/24" value={f.values.cidr} onChange={(v) => { f.set('cidr')(v); const h = cidrSuggest(v); if (h && !f.values.gateway && !f.values.rangeStart) f.setValues((x) => ({ ...x, cidr: v, gateway: h.gateway, rangeStart: h.start, rangeEnd: h.end })); }}
        error={f.fieldError('cidr')} spellCheck={false}/>
      <TextInput label={t('ip.gateway')} value={f.values.gateway} onChange={f.set('gateway')} error={f.fieldError('gateway')} spellCheck={false}/>
      {hint && <div className="flex flex-wrap items-center gap-2 text-xs text-muted sm:col-span-2"><I name="sparkles" size={14} className="text-accent"/>{t('form.cidrHint', { gateway: hint.gateway, start: hint.start, end: hint.end, n: hint.usable })}
        <Button size="sm" variant="ghost" onPress={fill}>{t('form.apply')}</Button></div>}
    </FieldGroup>
    <FieldGroup title={t('form.range')} description={t('form.rangeHelp')}>
      <TextInput label={t('ip.start')} value={f.values.rangeStart} onChange={f.set('rangeStart')} error={f.fieldError('range')} spellCheck={false}/>
      <TextInput label={t('ip.end')} value={f.values.rangeEnd} onChange={f.set('rangeEnd')} spellCheck={false}/>
      <TextInput className="sm:col-span-2" label={t('ip.excluded')} help={t('ip.listHelp')} value={f.values.excluded} onChange={f.set('excluded')} spellCheck={false}/>
    </FieldGroup>
    <FieldGroup title="DNS" cols={1}><TextInput label={t('form.dnsServers')} help={t('ip.listHelp')} value={f.values.dns} onChange={f.set('dns')} spellCheck={false}/></FieldGroup>
    <FieldGroup title={t('ipm.quarantine')} description={t('ipm.quarantineHelp')} cols={1}>
      <NumberInput label={t('ipm.quarantineHours')} value={num(f.values.quarantineHours)} onChange={(v) => f.set('quarantineHours')(str(v))} minValue={0} maxValue={8760} error={f.fieldError('quarantineHours')}/>
    </FieldGroup>
    <FieldGroup title="IPv6" description={t('ipm.ipv6Help')}>
      <TextInput label={t('ipm.ipv6Prefix')} value={f.values.ipv6Prefix} onChange={f.set('ipv6Prefix')} placeholder="2001:db8:40::/64" error={f.fieldError('ipv6Prefix')} spellCheck={false}/>
      <TextInput label={t('ipm.ipv6Gateway')} value={f.values.ipv6Gateway} onChange={f.set('ipv6Gateway')} placeholder="2001:db8:40::1" error={f.fieldError('ipv6Gateway')} spellCheck={false}/>
    </FieldGroup>
    <FormFooter failure={f.failure?.text} busy={f.busy} label={t('ip.create')} onCancel={onSaved}/>
  </form>;
}

function QuotaForm({ users, onSaved }: { users: { id: string; email: string }[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const saved = useSaved(onSaved);
  const f = useApiForm({ subject: 'default', maxServers: '', maxVcpu: '', maxMemoryMb: '', maxDiskGb: '' });
  const value = (s: string) => (s === '' ? null : Number(s));
  const limit = (k: 'maxServers' | 'maxVcpu' | 'maxMemoryMb' | 'maxDiskGb', gb = false) => <NumberInput key={k} label={gb ? `${t(`quotas.${k}`)} (GB)` : t(`quotas.${k}`)} minValue={0}
    value={num(f.values[k]) !== undefined ? (gb ? num(f.values[k])! / 1024 : num(f.values[k])) : undefined}
    onChange={(v) => f.set(k)(str(v === undefined ? undefined : gb ? Math.round(v * 1024) : v))} error={f.fieldError(k)} help={t('quotas.emptyUnlimited')}/>;
  return <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => { e.preventDefault();
    const body = { maxServers: value(f.values.maxServers), maxVcpu: value(f.values.maxVcpu), maxMemoryMb: value(f.values.maxMemoryMb), maxDiskGb: value(f.values.maxDiskGb) };
    saved(await f.submit('PUT', f.values.subject === 'default' ? '/admin/quotas/default' : `/admin/quotas/users/${f.values.subject}`, body)); }}>
    <FieldGroup title={t('quotas.scope')} description={t('form.scopeHelp')} cols={1}>
      <SelectInput label={t('quotas.scope')} value={f.values.subject} onChange={f.set('subject')} options={[{ id: 'default', label: t('quotas.default') }, ...users.map((u) => ({ id: u.id, label: u.email }))]}/>
    </FieldGroup>
    <FieldGroup title={t('form.limits')}>{limit('maxServers')}{limit('maxVcpu')}{limit('maxMemoryMb', true)}{limit('maxDiskGb')}</FieldGroup>
    <FormFooter failure={f.failure?.text} busy={f.busy} label={t('quotas.save')} onCancel={onSaved}/>
  </form>;
}

// How many more of this package each of its pools can still take, and what runs out first (CPU, RAM or disk).
function Sellable({ pkg, pools }: { pkg: Pkg; pools: Pool[] }) {
  const t = useTranslations('Catalog');
  const mine = pools.filter((p) => pkg.poolIds.includes(p.id));
  if (!mine.length) return <span className="text-muted">–</span>;
  return <ul className="flex flex-col gap-1">{mine.map((p) => {
    const r = sellable(p.capacity.available, pkg);
    const tone = r.count === 0 ? 'bg-danger/15 text-danger' : r.count < 5 ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success';
    const limit = t(('packages.limit.' + r.limit) as 'packages.limit.cpu');
    return <li key={p.id} className="flex items-center gap-2 text-xs" title={t('packages.sellableHint', { limit })}>
      <span className={'min-w-8 rounded-full px-2 py-0.5 text-center font-semibold tabular-nums ' + tone}>{r.count}</span>
      <span className="truncate text-muted">{mine.length > 1 ? p.name + ' · ' : ''}{t('packages.limitBy', { limit })}</span>
    </li>;
  })}</ul>;
}
