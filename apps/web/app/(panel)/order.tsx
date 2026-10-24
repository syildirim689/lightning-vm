"use client";
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiFetch, useErrorText } from '../../lib/api';
import { Field, useApiForm } from '../../lib/form';
import { useRouter } from 'next/navigation';
import { useIntentKey } from './servers-ui';

type Custom = { cpuMin: number; cpuMax: number; cpuStep: number; memoryMinMb: number; memoryMaxMb: number; memoryStepMb: number; diskMinGb: number; diskMaxGb: number; diskStepGb: number; currency: string };
type Catalog = { packages: { id: string; name: string; vcpu: number; memoryMb: number; diskGb: number; priceMonthly: string; currency: string; poolIds: string[]; imageIds: string[] }[];
  pools: { id: string; name: string; location: string; custom: Custom | null }[]; images: { id: string; name: string; family: string; minDiskGb: number }[] };
type Quote = { shape: { vcpu: number; memoryMb: number; diskGb: number }; price: { monthly: string; currency: string }; quota: { exceeded: string[] }; capacityAvailable: boolean };
type Project = { id: string; name: string };

export function Projects({ onChange }: { onChange: (p: Project[]) => void }) {
  const t = useTranslations('Order');
  const { error } = useErrorText();
  const [projects, setProjects] = useState<Project[]>([]);
  const f = useApiForm({ name: '' });
  const [message, setMessage] = useState<string>();
  const load = () => apiFetch<{ projects: Project[] }>('/projects').then((r) => { setProjects(r.projects); onChange(r.projects); }, (e) => setMessage(error(e)));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <article><h2>{t('projects.title')}</h2>
    {message && <p aria-live="polite">{message}</p>}
    {projects.length === 0 ? <p className="muted">{t('projects.empty')}</p> : <ul>{projects.map((p) => <li key={p.id}>{p.name}{' '}
      <button type="button" className="secondary small" onClick={() => apiFetch(`/projects/${p.id}`, { method: 'DELETE' }).then(load, (e) => setMessage(error(e)))}>{t('projects.remove')}</button></li>)}</ul>}
    <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); if (await f.submit('POST', '/projects')) { f.setValues({ name: '' }); load(); } }} noValidate>
      <Field id="project-name" label={t('projects.name')} error={f.fieldError('name')}><input id="project-name" value={f.values.name} onChange={f.set('name')}/></Field>
      <button type="submit" className="primary" disabled={f.busy}>{t('projects.create')}</button>
    </form>
  </article>;
}

// Builds, prices and places an order. The server validates everything.
export function Order({ projects, keys }: { projects: Project[]; keys: { id: string; name: string }[] }) {
  const t = useTranslations('Order');
  const format = useFormatter();
  const [catalog, setCatalog] = useState<Catalog>();
  const [quote, setQuote] = useState<Quote>();
  const f = useApiForm({ type: 'package', poolId: '', packageId: '', imageId: '', projectId: '', vcpu: '2', memoryMb: '4096', diskGb: '40', name: '' });
  const [keyIds, setKeyIds] = useState<string[]>([]);
  const intent = useIntentKey();
  const router = useRouter();
  useEffect(() => { apiFetch<Catalog>('/catalog').then((c) => { setCatalog(c); f.setValues((v) => ({ ...v, poolId: c.pools[0]?.id ?? '' })); }, () => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (f.failure && f.failure.code !== 'NETWORK') intent.reset(); }, [f.failure]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!catalog) return null;
  if (!catalog.pools.length) return <article><h2>{t('title')}</h2><p className="muted">{t('nothingOffered')}</p></article>;
  const pool = catalog.pools.find((p) => p.id === f.values.poolId);
  const packages = catalog.packages.filter((p) => p.poolIds.includes(f.values.poolId));
  const custom = pool?.custom;
  const orderBody = () => {
    const v = f.values;
    return { type: v.type, poolId: v.poolId, ...(v.imageId && { imageId: v.imageId }), ...(v.projectId && { projectId: v.projectId }),
      ...(v.type === 'package' ? { packageId: v.packageId } : { vcpu: Number(v.vcpu), memoryMb: Number(v.memoryMb), diskGb: Number(v.diskGb) }) };
  };
  async function price(e: React.FormEvent) {
    e.preventDefault(); setQuote(undefined);
    setQuote(await f.submit<Quote>('POST', '/catalog/quote', orderBody()));
  }
  // The same key is reused until the server has answered; only a network failure keeps it for a retry.
  async function create() {
    const out = await f.submit<{ serverId: string }>('POST', '/servers', { ...orderBody(), name: f.values.name, sshKeyIds: keyIds }, { 'idempotency-key': intent.key() });
    if (out) { intent.reset(); router.push(`/servers/${out.serverId}`); }
  }
  const gb = (mb: number) => format.number(mb / 1024, { maximumFractionDigits: 1 });
  return <article><h2>{t('title')}</h2>
    <form onSubmit={price} noValidate>
      <div className="grid-3">
        <Field id="o-pool" label={t('location')} error={f.fieldError('poolId')}><select id="o-pool" value={f.values.poolId} onChange={f.set('poolId')}>
          {catalog.pools.map((p) => <option key={p.id} value={p.id}>{p.name}{p.location ? ` · ${p.location}` : ''}</option>)}</select></Field>
        <Field id="o-image" label={t('image')} error={f.fieldError('imageId')}><select id="o-image" value={f.values.imageId} onChange={f.set('imageId')}>
          <option value="">–</option>{catalog.images.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
        <Field id="o-project" label={t('project')}><select id="o-project" value={f.values.projectId} onChange={f.set('projectId')}>
          <option value="">–</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      </div>
      <fieldset><legend>{t('kind')}</legend>
        <label className="check"><input type="radio" name="type" value="package" checked={f.values.type === 'package'} onChange={f.set('type')}/>{t('package')}</label>
        <label className="check"><input type="radio" name="type" value="custom" checked={f.values.type === 'custom'} onChange={f.set('type')} disabled={!custom}/>{t('custom')}{!custom && ` (${t('noCustom')})`}</label>
      </fieldset>
      {f.values.type === 'package' && <Field id="o-package" label={t('package')} error={f.fieldError('packageId')}><select id="o-package" value={f.values.packageId} onChange={f.set('packageId')}>
        <option value="">–</option>{packages.map((p) => <option key={p.id} value={p.id}>{t('packageOption', { name: p.name, vcpu: p.vcpu, memory: gb(p.memoryMb), disk: p.diskGb,
          price: format.number(Number(p.priceMonthly), { style: 'currency', currency: p.currency }) })}</option>)}</select></Field>}
      {f.values.type === 'custom' && custom && <>
        <p className="notice">{t('customNote')}</p>
        <div className="grid-3">
          <Field id="o-vcpu" label="vCPU" help={t('range', { min: custom.cpuMin, max: custom.cpuMax, step: custom.cpuStep })} error={f.fieldError('vcpu')}>
            <input id="o-vcpu" type="number" min={custom.cpuMin} max={custom.cpuMax} step={custom.cpuStep} value={f.values.vcpu} onChange={f.set('vcpu')}/></Field>
          <Field id="o-mem" label="RAM (MB)" help={t('range', { min: custom.memoryMinMb, max: custom.memoryMaxMb, step: custom.memoryStepMb })} error={f.fieldError('memoryMb')}>
            <input id="o-mem" type="number" min={custom.memoryMinMb} max={custom.memoryMaxMb} step={custom.memoryStepMb} value={f.values.memoryMb} onChange={f.set('memoryMb')}/></Field>
          <Field id="o-disk" label={t('disk')} help={t('range', { min: custom.diskMinGb, max: custom.diskMaxGb, step: custom.diskStepGb })} error={f.fieldError('diskGb')}>
            <input id="o-disk" type="number" min={custom.diskMinGb} max={custom.diskMaxGb} step={custom.diskStepGb} value={f.values.diskGb} onChange={f.set('diskGb')}/></Field>
        </div></>}
      {f.failure && <p role="alert" className="error">{f.failure.text}</p>}
      <button type="submit" className="primary" disabled={f.busy}>{t('price')}</button>
    </form>
    {quote && <div className="quote" role="status">
      <p className="price">{t('monthly', { price: format.number(Number(quote.price.monthly), { style: 'currency', currency: quote.price.currency }) })}</p>
      <p>{t('shape', { vcpu: quote.shape.vcpu, memory: gb(quote.shape.memoryMb), disk: quote.shape.diskGb })}</p>
      {quote.quota.exceeded.length > 0 && <p className="error">{t('quotaExceeded', { limits: quote.quota.exceeded.map((q) => t(`quota.${q as 'vcpu'}`)).join(', ') })}</p>}
      {!quote.capacityAvailable && <p className="error">{t('noCapacity')}</p>}
    </div>}
    {quote && !quote.quota.exceeded.length && quote.capacityAvailable && <div className="create">
      <Field id="o-name" label={t('name')} help={t('nameHelp')} error={f.fieldError('name')}><input id="o-name" value={f.values.name} onChange={f.set('name')} autoComplete="off"/></Field>
      <fieldset><legend>{t('sshKeys')}</legend>
        {keys.length === 0 && <span className="muted">{t('noKeys')}</span>}
        {keys.map((k) => <label key={k.id} className="check"><input type="checkbox" checked={keyIds.includes(k.id)}
          onChange={(e) => setKeyIds(e.target.checked ? [...keyIds, k.id] : keyIds.filter((x) => x !== k.id))}/>{k.name}</label>)}
        {f.fieldError('sshKeyIds') && <small className="error">{f.fieldError('sshKeyIds')}</small>}
      </fieldset>
      <button type="button" className="primary" disabled={f.busy} onClick={create}>{t('create')}</button>
    </div>}
  </article>;
}
