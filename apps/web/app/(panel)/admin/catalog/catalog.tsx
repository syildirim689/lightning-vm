"use client";
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { Field, useApiForm } from '../../../../lib/form';

type Inventory = { compute: { moref: string; name: string; kind: string }[]; datastores: { moref: string; name: string }[]; networks: { moref: string; name: string; vlan: number | null }[]; vms: { moref: string; name: string; template: boolean }[] };
type Connection = { id: string; name: string };
type Layer = Record<string, number>;
type Capacity = { physical: Layer; headroom: Layer; offered: Layer; used: Layer; reserved: Layer; available: Layer; realFreeGb: number; warnings: string[] };
type Pool = { id: string; name: string; location: string; connectionName: string; cpuOvercommit: number; memoryOvercommit: number; storageOvercommit: number; capacity: Capacity; customRule: Record<string, unknown> | null };
type Pkg = { id: string; name: string; vcpu: number; memoryMb: number; diskGb: number; priceMonthly: string; currency: string; poolIds: string[] };
type Image = { id: string; name: string; family: string; templateName: string | null; minDiskGb: number };
type IpPool = { id: string; name: string; poolName: string; cidr: string; gateway: string; rangeStart: string; rangeEnd: string; size: number };
type Quota = { scope: string; email: string | null; maxServers: number | null; maxVcpu: number | null; maxMemoryMb: number | null; maxDiskGb: number | null };

export default function Catalog() {
  const t = useTranslations('Catalog');
  const { error } = useErrorText();
  const [data, setData] = useState<{ pools: Pool[]; packages: Pkg[]; images: Image[]; ipPools: IpPool[]; quotas: Quota[]; connections: Connection[]; users: { id: string; email: string }[] }>();
  const [message, setMessage] = useState<string>();
  const load = useCallback(async () => {
    try {
      const [pools, packages, images, ipPools, quotas, connections, users] = await Promise.all([
        apiFetch<{ pools: Pool[] }>('/admin/pools'), apiFetch<{ packages: Pkg[] }>('/admin/packages'), apiFetch<{ images: Image[] }>('/admin/images'),
        apiFetch<{ ipPools: IpPool[] }>('/admin/ip-pools'), apiFetch<{ quotas: Quota[] }>('/admin/quotas'),
        apiFetch<{ connections: Connection[] }>('/admin/vmware/connections'), apiFetch<{ users: { id: string; email: string }[] }>('/admin/users')]);
      setData({ pools: pools.pools, packages: packages.packages, images: images.images, ipPools: ipPools.ipPools, quotas: quotas.quotas, connections: connections.connections, users: users.users });
    } catch (e) { setMessage(error(e)); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const done = (text: string) => { setMessage(text); load(); };
  async function remove(path: string) {
    try { await apiFetch(path, { method: 'DELETE' }); done(t('removed')); } catch (e) { setMessage(error(e)); }
  }
  if (!data) return <p role="status">{message ?? t('loading')}</p>;
  return <>
    {message && <p aria-live="polite">{message}</p>}
    <p className="notice">{t('poolsExplain')}</p>
    <section><h2>{t('pools.title')}</h2>
      {data.pools.length === 0 && <p className="muted">{t('pools.empty')}</p>}
      {data.pools.map((p) => <PoolCard key={p.id} pool={p} onRemove={() => remove(`/admin/pools/${p.id}`)} onSaved={() => done(t('saved'))}/>)}
      {data.connections.length ? <PoolForm connections={data.connections} onSaved={() => done(t('saved'))}/> : <p className="notice">{t('pools.needConnection')}</p>}
    </section>
    <section><h2>{t('images.title')}</h2>
      <table><thead><tr><th>{t('col.name')}</th><th>{t('images.family')}</th><th>{t('images.template')}</th><th>{t('images.minDisk')}</th><th/></tr></thead>
        <tbody>{data.images.map((i) => <tr key={i.id}><td>{i.name}</td><td>{i.family}</td><td>{i.templateName ?? '–'}</td><td>{i.minDiskGb} GB</td>
          <td><button type="button" className="secondary" onClick={() => remove(`/admin/images/${i.id}`)}>{t('remove')}</button></td></tr>)}</tbody></table>
      <ImageForm connections={data.connections} onSaved={() => done(t('saved'))}/>
    </section>
    <section><h2>{t('packages.title')}</h2>
      <table><thead><tr><th>{t('col.name')}</th><th>vCPU</th><th>RAM</th><th>{t('col.disk')}</th><th>{t('col.price')}</th><th/></tr></thead>
        <tbody>{data.packages.map((p) => <tr key={p.id}><td>{p.name}</td><td>{p.vcpu}</td><td>{p.memoryMb / 1024} GB</td><td>{p.diskGb} GB</td><td><Money amount={p.priceMonthly} currency={p.currency}/></td>
          <td><button type="button" className="secondary" onClick={() => remove(`/admin/packages/${p.id}`)}>{t('remove')}</button></td></tr>)}</tbody></table>
      {data.pools.length ? <PackageForm pools={data.pools} images={data.images} onSaved={() => done(t('saved'))}/> : <p className="muted">{t('packages.needPool')}</p>}
    </section>
    <section><h2>{t('ip.title')}</h2>
      <table><thead><tr><th>{t('col.name')}</th><th>{t('ip.pool')}</th><th>{t('ip.subnet')}</th><th>{t('ip.gateway')}</th><th>{t('ip.range')}</th><th>{t('ip.size')}</th><th/></tr></thead>
        <tbody>{data.ipPools.map((i) => <tr key={i.id}><td>{i.name}</td><td>{i.poolName}</td><td>{i.cidr}</td><td>{i.gateway}</td><td>{i.rangeStart} – {i.rangeEnd}</td><td>{i.size}</td>
          <td><button type="button" className="secondary" onClick={() => remove(`/admin/ip-pools/${i.id}`)}>{t('remove')}</button></td></tr>)}</tbody></table>
      {data.pools.length ? <IpPoolForm pools={data.pools} onSaved={() => done(t('saved'))}/> : <p className="muted">{t('packages.needPool')}</p>}
    </section>
    <section><h2>{t('quotas.title')}</h2><p className="muted">{t('quotas.explain')}</p>
      <table><thead><tr><th>{t('quotas.scope')}</th><th>{t('quotas.servers')}</th><th>vCPU</th><th>RAM (MB)</th><th>{t('col.disk')} (GB)</th></tr></thead>
        <tbody>{data.quotas.map((q) => <tr key={`${q.scope}-${q.email}`}><td>{q.scope === 'default' ? t('quotas.default') : q.email}</td>
          {[q.maxServers, q.maxVcpu, q.maxMemoryMb, q.maxDiskGb].map((v, i) => <td key={i}>{v ?? t('quotas.unlimited')}</td>)}</tr>)}</tbody></table>
      <QuotaForm users={data.users} onSaved={() => done(t('saved'))}/>
    </section>
  </>;
}

function Money({ amount, currency }: { amount: string; currency: string }) {
  const format = useFormatter();
  // Display only; the stored and calculated amounts stay decimal strings.
  return <>{format.number(Number(amount), { style: 'currency', currency })}</>;
}

function PoolCard({ pool, onRemove, onSaved }: { pool: Pool; onRemove: () => void; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const format = useFormatter();
  const c = pool.capacity;
  const row = (key: string, layer: Layer, cpu: string, mem: string, disk: string) => <tr key={key}><th>{t(`layer.${key as 'physical'}`)}</th>
    <td>{format.number(layer[cpu] ?? 0)}</td><td>{format.number(Math.round((layer[mem] ?? 0) / 1024))} GB</td><td>{format.number(layer[disk] ?? 0)} GB</td></tr>;
  return <article>
    <h3>{pool.name} <span className="muted">· {pool.location || '–'} · {pool.connectionName}</span></h3>
    <p className="muted">{t('pools.ratios', { cpu: pool.cpuOvercommit, memory: pool.memoryOvercommit, storage: pool.storageOvercommit })}</p>
    <table className="capacity"><thead><tr><th/><th>{t('col.cpu')}</th><th>RAM</th><th>{t('col.storage')}</th></tr></thead><tbody>
      {row('physical', c.physical, 'cores', 'memoryMb', 'storageGb')}
      {row('headroom', c.headroom, 'cores', 'memoryMb', 'storageGb')}
      {row('offered', c.offered, 'vcpu', 'memoryMb', 'storageGb')}
      {row('reserved', c.reserved, 'vcpu', 'memoryMb', 'diskGb')}
      {row('used', c.used, 'vcpu', 'memoryMb', 'storageProvisionedGb')}
      {row('available', c.available, 'vcpu', 'memoryMb', 'storageGb')}
    </tbody></table>
    <p className="muted">{t('pools.storageNote', { written: c.used.storageWrittenGb, provisioned: c.used.storageProvisionedGb, free: c.realFreeGb })}</p>
    {c.warnings.map((w) => <p key={w} className="notice">{t(`warning.${w as 'STORAGE_OVERPROVISIONED'}`)}</p>)}
    <details><summary>{pool.customRule ? t('rule.edit') : t('rule.add')}</summary><RuleForm poolId={pool.id} rule={pool.customRule} onSaved={onSaved}/></details>
    <div className="actions"><button type="button" className="secondary" onClick={onRemove}>{t('remove')}</button></div>
  </article>;
}

function PoolForm({ connections, onSaved }: { connections: Connection[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const f = useApiForm({ name: '', location: '', connectionId: connections[0].id, computeMoref: '', networkMoref: '', cpuOvercommit: '4', memoryOvercommit: '1', storageOvercommit: '1',
    reserveCpuPct: '10', reserveMemoryPct: '10', reserveStoragePct: '15' });
  const [inv, setInv] = useState<Inventory>();
  const [stores, setStores] = useState<string[]>([]);
  useEffect(() => { apiFetch<Inventory>(`/admin/vmware/connections/${f.values.connectionId}`).then(setInv, () => setInv(undefined)); }, [f.values.connectionId]);
  const num = (k: 'cpuOvercommit' | 'memoryOvercommit' | 'storageOvercommit' | 'reserveCpuPct' | 'reserveMemoryPct' | 'reserveStoragePct', step: string) =>
    <Field id={`pool-${k}`} label={t(`pools.${k}`)} help={t(`pools.${k}Help`)} error={f.fieldError(k)}><input id={`pool-${k}`} type="number" step={step} value={f.values[k]} onChange={f.set(k)}/></Field>;
  return <form className="card-form" onSubmit={async (e) => { e.preventDefault(); if (await f.submit('POST', '/admin/pools', { ...f.values, datastoreMorefs: stores })) onSaved(); }} noValidate>
    <h3>{t('pools.new')}</h3>
    <Field id="pool-name" label={t('col.name')} error={f.fieldError('name')}><input id="pool-name" value={f.values.name} onChange={f.set('name')}/></Field>
    <Field id="pool-location" label={t('pools.location')} help={t('pools.locationHelp')}><input id="pool-location" value={f.values.location} onChange={f.set('location')}/></Field>
    <Field id="pool-conn" label={t('pools.connection')}><select id="pool-conn" value={f.values.connectionId} onChange={f.set('connectionId')}>{connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
    <Field id="pool-compute" label={t('pools.compute')} error={f.fieldError('computeMoref')}><select id="pool-compute" value={f.values.computeMoref} onChange={f.set('computeMoref')}>
      <option value="">–</option>{inv?.compute.map((c) => <option key={c.moref} value={c.moref}>{c.name} ({c.kind})</option>)}</select></Field>
    <fieldset><legend>{t('pools.datastores')}</legend>{inv?.datastores.map((d) => <label key={d.moref} className="check">
      <input type="checkbox" checked={stores.includes(d.moref)} onChange={(e) => setStores(e.target.checked ? [...stores, d.moref] : stores.filter((s) => s !== d.moref))}/>{d.name}</label>)}
      {f.fieldError('datastoreMorefs') && <small className="error">{f.fieldError('datastoreMorefs')}</small>}</fieldset>
    <Field id="pool-network" label={t('pools.network')} error={f.fieldError('networkMoref')}><select id="pool-network" value={f.values.networkMoref} onChange={f.set('networkMoref')}>
      <option value="">–</option>{inv?.networks.map((n) => <option key={n.moref} value={n.moref}>{n.name}{n.vlan !== null ? ` (VLAN ${n.vlan})` : ''}</option>)}</select></Field>
    <div className="grid-3">{num('cpuOvercommit', '0.1')}{num('memoryOvercommit', '0.1')}{num('storageOvercommit', '0.1')}</div>
    <div className="grid-3">{num('reserveCpuPct', '1')}{num('reserveMemoryPct', '1')}{num('reserveStoragePct', '1')}</div>
    {f.failure && <p role="alert" className="error">{f.failure.text}</p>}
    <button type="submit" className="primary" disabled={f.busy}>{t('pools.create')}</button>
  </form>;
}

const ruleKeys = ['cpuMin', 'cpuMax', 'cpuStep', 'memoryMinMb', 'memoryMaxMb', 'memoryStepMb', 'diskMinGb', 'diskMaxGb', 'diskStepGb', 'minMemoryMbPerVcpu', 'maxMemoryMbPerVcpu', 'priceVcpu', 'priceMemoryGb', 'priceDiskGb', 'currency'] as const;
const ruleColumns: Record<(typeof ruleKeys)[number], string> = { cpuMin: 'cpu_min', cpuMax: 'cpu_max', cpuStep: 'cpu_step', memoryMinMb: 'memory_min_mb', memoryMaxMb: 'memory_max_mb',
  memoryStepMb: 'memory_step_mb', diskMinGb: 'disk_min_gb', diskMaxGb: 'disk_max_gb', diskStepGb: 'disk_step_gb', minMemoryMbPerVcpu: 'min_memory_mb_per_vcpu',
  maxMemoryMbPerVcpu: 'max_memory_mb_per_vcpu', priceVcpu: 'price_vcpu', priceMemoryGb: 'price_memory_gb', priceDiskGb: 'price_disk_gb', currency: 'currency' };
const ruleDefaults = { cpuMin: '1', cpuMax: '16', cpuStep: '1', memoryMinMb: '1024', memoryMaxMb: '65536', memoryStepMb: '1024', diskMinGb: '20', diskMaxGb: '1000', diskStepGb: '10',
  minMemoryMbPerVcpu: '1024', maxMemoryMbPerVcpu: '8192', priceVcpu: '', priceMemoryGb: '', priceDiskGb: '', currency: 'EUR' };

function RuleForm({ poolId, rule, onSaved }: { poolId: string; rule: Record<string, unknown> | null; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const f = useApiForm(Object.fromEntries(ruleKeys.map((k) => [k, rule ? String(rule[ruleColumns[k]]) : ruleDefaults[k]])) as Record<(typeof ruleKeys)[number], string>);
  return <form onSubmit={async (e) => { e.preventDefault(); if (await f.submit('PUT', `/admin/pools/${poolId}/custom-rule`)) onSaved(); }} noValidate>
    <p className="muted">{t('rule.explain')}</p>
    <div className="grid-3">{ruleKeys.map((k) => <Field key={k} id={`rule-${poolId}-${k}`} label={t(`rule.${k}`)} error={f.fieldError(k)}>
      <input id={`rule-${poolId}-${k}`} value={f.values[k]} onChange={f.set(k)} inputMode={k === 'currency' ? 'text' : 'decimal'}/></Field>)}</div>
    {f.failure && <p role="alert" className="error">{f.failure.text}</p>}
    <button type="submit" className="primary" disabled={f.busy}>{t('rule.save')}</button>
  </form>;
}

function ImageForm({ connections, onSaved }: { connections: Connection[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const f = useApiForm({ name: '', family: 'linux', connectionId: connections[0]?.id ?? '', templateMoref: '', minDiskGb: '20' });
  const [vms, setVms] = useState<Inventory['vms']>([]);
  useEffect(() => { if (f.values.connectionId) apiFetch<Inventory>(`/admin/vmware/connections/${f.values.connectionId}`).then((i) => setVms(i.vms.filter((v) => v.template)), () => setVms([])); }, [f.values.connectionId]);
  if (!connections.length) return null;
  return <form className="card-form" onSubmit={async (e) => { e.preventDefault(); if (await f.submit('POST', '/admin/images')) onSaved(); }} noValidate>
    <h3>{t('images.new')}</h3><p className="muted">{t('images.explain')}</p>
    <Field id="img-name" label={t('col.name')} error={f.fieldError('name')}><input id="img-name" value={f.values.name} onChange={f.set('name')}/></Field>
    <Field id="img-family" label={t('images.family')}><select id="img-family" value={f.values.family} onChange={f.set('family')}><option value="linux">Linux</option><option value="windows">Windows</option></select></Field>
    <Field id="img-conn" label={t('pools.connection')}><select id="img-conn" value={f.values.connectionId} onChange={f.set('connectionId')}>{connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
    <Field id="img-template" label={t('images.template')} error={f.fieldError('templateMoref')} help={vms.length ? undefined : t('images.noTemplates')}>
      <select id="img-template" value={f.values.templateMoref} onChange={f.set('templateMoref')}><option value="">–</option>{vms.map((v) => <option key={v.moref} value={v.moref}>{v.name}</option>)}</select></Field>
    <Field id="img-disk" label={t('images.minDisk')} error={f.fieldError('minDiskGb')}><input id="img-disk" type="number" value={f.values.minDiskGb} onChange={f.set('minDiskGb')}/></Field>
    {f.failure && <p role="alert" className="error">{f.failure.text}</p>}
    <button type="submit" className="primary" disabled={f.busy}>{t('images.create')}</button>
  </form>;
}

function PackageForm({ pools, images, onSaved }: { pools: Pool[]; images: Image[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const f = useApiForm({ name: '', vcpu: '2', memoryMb: '4096', diskGb: '40', priceMonthly: '', priceHourly: '', currency: 'EUR' });
  const [poolIds, setPoolIds] = useState<string[]>([]);
  const [imageIds, setImageIds] = useState<string[]>([]);
  const checks = (items: { id: string; name: string }[], selected: string[], set: (v: string[]) => void) => items.map((i) => <label key={i.id} className="check">
    <input type="checkbox" checked={selected.includes(i.id)} onChange={(e) => set(e.target.checked ? [...selected, i.id] : selected.filter((s) => s !== i.id))}/>{i.name}</label>);
  return <form className="card-form" onSubmit={async (e) => { e.preventDefault(); if (await f.submit('POST', '/admin/packages', { ...f.values, poolIds, imageIds })) onSaved(); }} noValidate>
    <h3>{t('packages.new')}</h3>
    <Field id="pkg-name" label={t('col.name')} error={f.fieldError('name')}><input id="pkg-name" value={f.values.name} onChange={f.set('name')}/></Field>
    <div className="grid-3">
      <Field id="pkg-vcpu" label="vCPU" error={f.fieldError('vcpu')}><input id="pkg-vcpu" type="number" value={f.values.vcpu} onChange={f.set('vcpu')}/></Field>
      <Field id="pkg-mem" label="RAM (MB)" error={f.fieldError('memoryMb')}><input id="pkg-mem" type="number" step="512" value={f.values.memoryMb} onChange={f.set('memoryMb')}/></Field>
      <Field id="pkg-disk" label={`${t('col.disk')} (GB)`} error={f.fieldError('diskGb')}><input id="pkg-disk" type="number" value={f.values.diskGb} onChange={f.set('diskGb')}/></Field>
      <Field id="pkg-price" label={t('packages.priceMonthly')} error={f.fieldError('priceMonthly')}><input id="pkg-price" inputMode="decimal" value={f.values.priceMonthly} onChange={f.set('priceMonthly')}/></Field>
      <Field id="pkg-hourly" label={t('packages.priceHourly')} error={f.fieldError('priceHourly')}><input id="pkg-hourly" inputMode="decimal" value={f.values.priceHourly} onChange={f.set('priceHourly')}/></Field>
      <Field id="pkg-cur" label={t('packages.currency')} error={f.fieldError('currency')} help={t('packages.currencyHelp')}><input id="pkg-cur" value={f.values.currency} onChange={f.set('currency')} maxLength={3}/></Field>
    </div>
    <fieldset><legend>{t('packages.pools')}</legend>{checks(pools, poolIds, setPoolIds)}{f.fieldError('poolIds') && <small className="error">{f.fieldError('poolIds')}</small>}</fieldset>
    <fieldset><legend>{t('packages.images')}</legend>{checks(images, imageIds, setImageIds)}</fieldset>
    {f.failure && <p role="alert" className="error">{f.failure.text}</p>}
    <button type="submit" className="primary" disabled={f.busy}>{t('packages.create')}</button>
  </form>;
}

function IpPoolForm({ pools, onSaved }: { pools: Pool[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const f = useApiForm({ name: '', poolId: pools[0].id, cidr: '', gateway: '', rangeStart: '', rangeEnd: '', dns: '', excluded: '' });
  const list = (s: string) => s.split(/[\s,]+/).filter(Boolean);
  return <form className="card-form" onSubmit={async (e) => { e.preventDefault(); if (await f.submit('POST', '/admin/ip-pools', { ...f.values, dns: list(f.values.dns), excluded: list(f.values.excluded) })) onSaved(); }} noValidate>
    <h3>{t('ip.new')}</h3><p className="muted">{t('ip.explain')}</p>
    <Field id="ip-name" label={t('col.name')} error={f.fieldError('name')}><input id="ip-name" value={f.values.name} onChange={f.set('name')}/></Field>
    <Field id="ip-pool" label={t('ip.pool')}><select id="ip-pool" value={f.values.poolId} onChange={f.set('poolId')}>{pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
    <div className="grid-3">
      <Field id="ip-cidr" label={t('ip.subnet')} help="203.0.113.0/24" error={f.fieldError('cidr')}><input id="ip-cidr" value={f.values.cidr} onChange={f.set('cidr')}/></Field>
      <Field id="ip-gw" label={t('ip.gateway')} error={f.fieldError('gateway')}><input id="ip-gw" value={f.values.gateway} onChange={f.set('gateway')}/></Field>
      <Field id="ip-dns" label="DNS" help={t('ip.listHelp')}><input id="ip-dns" value={f.values.dns} onChange={f.set('dns')}/></Field>
      <Field id="ip-start" label={t('ip.start')} error={f.fieldError('range')}><input id="ip-start" value={f.values.rangeStart} onChange={f.set('rangeStart')}/></Field>
      <Field id="ip-end" label={t('ip.end')}><input id="ip-end" value={f.values.rangeEnd} onChange={f.set('rangeEnd')}/></Field>
      <Field id="ip-excl" label={t('ip.excluded')} help={t('ip.listHelp')}><input id="ip-excl" value={f.values.excluded} onChange={f.set('excluded')}/></Field>
    </div>
    {f.failure && <p role="alert" className="error">{f.failure.text}</p>}
    <button type="submit" className="primary" disabled={f.busy}>{t('ip.create')}</button>
  </form>;
}

function QuotaForm({ users, onSaved }: { users: { id: string; email: string }[]; onSaved: () => void }) {
  const t = useTranslations('Catalog');
  const f = useApiForm({ subject: 'default', maxServers: '', maxVcpu: '', maxMemoryMb: '', maxDiskGb: '' });
  const value = (s: string) => (s === '' ? null : Number(s));
  return <form className="card-form" onSubmit={async (e) => { e.preventDefault();
    const body = { maxServers: value(f.values.maxServers), maxVcpu: value(f.values.maxVcpu), maxMemoryMb: value(f.values.maxMemoryMb), maxDiskGb: value(f.values.maxDiskGb) };
    if (await f.submit('PUT', f.values.subject === 'default' ? '/admin/quotas/default' : `/admin/quotas/users/${f.values.subject}`, body)) onSaved(); }} noValidate>
    <h3>{t('quotas.set')}</h3>
    <Field id="q-subject" label={t('quotas.scope')}><select id="q-subject" value={f.values.subject} onChange={f.set('subject')}>
      <option value="default">{t('quotas.default')}</option>{users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}</select></Field>
    <div className="grid-3">{(['maxServers', 'maxVcpu', 'maxMemoryMb', 'maxDiskGb'] as const).map((k) => <Field key={k} id={`q-${k}`} label={t(`quotas.${k}`)} help={t('quotas.emptyUnlimited')} error={f.fieldError(k)}>
      <input id={`q-${k}`} type="number" value={f.values[k]} onChange={f.set(k)}/></Field>)}</div>
    {f.failure && <p role="alert" className="error">{f.failure.text}</p>}
    <button type="submit" className="primary" disabled={f.busy}>{t('quotas.save')}</button>
  </form>;
}
