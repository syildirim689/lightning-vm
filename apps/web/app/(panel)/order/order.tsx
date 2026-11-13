"use client";
import NextLink from 'next/link';
import { Button, Card, Radio, RadioGroup, Separator, Spinner, toast } from '@heroui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../components/icon';
import { ButtonLink, CheckboxList, Empty, Notice, NumberInput, PageHeader, Section, SelectInput, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../lib/api';
import { hostnameSchema, orderBody, useOrder } from '../../../lib/order-store';
import { LocationPicker, type OrderLocation } from './locations';
import { WorkloadAdvisor } from './advisor';
import { needs, pick, snap, type Traffic, type Workload } from '../../../lib/sizing';
import { useApiQuery } from '../../../lib/query';
import type { Summary } from '../../../lib/billing';
import { useIntentKey, useSshKeys } from '../servers-ui';
import { Copy } from '../server-extras';
import { strongPassword } from '../../../lib/password';
import { Strength } from '../../(auth)/credentials-form';

type Custom = { cpuMin: number; cpuMax: number; cpuStep: number; memoryMinMb: number; memoryMaxMb: number; memoryStepMb: number; diskMinGb: number; diskMaxGb: number; diskStepGb: number; currency: string };
type Catalog = { packages: { id: string; name: string; vcpu: number; memoryMb: number; diskGb: number; priceMonthly: string; currency: string; poolIds: string[]; imageIds: string[] }[];
  locations: OrderLocation[];
  pools: { id: string; name: string; location: string; locationId: string | null; custom: Custom | null; extraIpv4Max: number; extraIpv4Price: string; ipv6: boolean }[]; images: { id: string; name: string; family: string; minDiskGb: number }[];
  applications: { id: string; name: string; kind: string; description: string; minMemoryMb: number; minDiskGb: number; priceMonthly: string; available: boolean }[] };
type Quote = { shape: { vcpu: number; memoryMb: number; diskGb: number }; price: { monthly: string; currency: string }; quota: { exceeded: string[] }; capacityAvailable: boolean;
  budget: { amount: number; currency: string; monthly: number; state: 'ok' | 'near' | 'over' } | null;
  coupon: { code: string; monthly: string; periods: number | null } | { error: string } | null };
type Project = { id: string; name: string };
type Availability = { packages: Record<string, { capacity: boolean; quota: string[] }> };
const slug = (s: string) => s.toLocaleLowerCase('en').normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server';

// Builds, prices and places an order. Every value is validated again by the API.
export default function Order() {
  const t = useTranslations('Order');
  const format = useFormatter();
  const { error, field } = useErrorText();
  const router = useRouter();
  const intent = useIntentKey();
  const d = useOrder();
  const billing = useApiQuery<Summary>(['notifications', 'billing-summary'], '/billing/summary').data;
  const hourly = billing?.enabled && billing.hourly?.enabled ? billing.hourly : null;
  const queryClient = useQueryClient();
  const keys = useSshKeys();
  const tf = useTranslations('Firewalls');
  const firewalls = useApiQuery<{ firewalls: { id: string; name: string }[] }>(['firewalls'], '/firewalls').data?.firewalls ?? [];
  const [firewallIds, setFirewallIds] = useState<string[]>([]);
  // Not kept in the draft (sessionStorage): a password stays only on this page.
  const [rootPassword, setRootPassword] = useState('');
  const catalog = useApiQuery<Catalog>(['catalog'], '/catalog').data;
  const projects = useApiQuery<{ projects: Project[] }>(['projects'], '/projects').data?.projects ?? [];
  const mine = useApiQuery<{ servers: { name: string }[] }>(['servers'], '/servers').data?.servers ?? [];
  const availability = useApiQuery<Availability>(['availability', d.poolId], d.poolId ? `/catalog/availability?poolId=${d.poolId}` : null).data;
  const [failure, setFailure] = useState<ApiError & { text: string }>();
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string>();
  const [want, setWant] = useState<{ w: Workload; traffic: Traffic } | null>(null);
  // The code typed, and the one applied to the quote (the API checks it again when the order is placed).
  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState('');

  // First pool by default, and drop selections that no longer exist in the catalog.
  useEffect(() => {
    if (!catalog) return;
    if (!catalog.pools.some((p) => p.id === d.poolId)) d.set({ poolId: catalog.pools[0]?.id ?? '' });
    if (d.packageId && !catalog.packages.some((p) => p.id === d.packageId)) d.set({ packageId: '' });
    if (d.applicationId && !catalog.applications.some((a) => a.id === d.applicationId)) d.set({ applicationId: '' });
  }, [catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = { ...orderBody(d), ...(coupon && d.billingCycle !== 'hourly' && { coupon }) };
  const pool = catalog?.pools.find((p) => p.id === d.poolId);
  // Another location may sell fewer extra addresses (or none).
  useEffect(() => { if (pool && (d.extraIpv4 ?? 0) > pool.extraIpv4Max) d.set({ extraIpv4: pool.extraIpv4Max }); }, [pool?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = !!d.poolId && (d.type === 'custom' ? !!pool?.custom : !!d.packageId);
  const quote = useQuery<Quote, ApiError>({
    queryKey: ['quote', body], enabled: ready,
    queryFn: () => apiFetch<Quote>('/catalog/quote', { method: 'POST', body }),
  });

  if (!catalog) return <p role="status" className="text-sm text-muted">…</p>;
  if (!catalog.pools.length) return <><PageHeader title={t('title')}/><Empty icon={<I name="map-pin" size={28}/>} title={t('nothingOffered')}/></>;
  const packages = catalog.packages.filter((p) => p.poolIds.includes(d.poolId));
  const image = catalog.images.find((i) => i.id === d.imageId);
  // Why a package cannot be ordered right now, if it cannot (the API checks again on create).
  const blocked = (p: Catalog['packages'][number]) => image && p.diskGb < image.minDiskGb ? t('why.imageDisk', { min: image.minDiskGb })
    : image?.family === 'esxi' && (p.vcpu < 2 || p.memoryMb < 4096) ? t('why.esxi')
    : availability?.packages[p.id] && !availability.packages[p.id].capacity ? t('why.capacity')
    : availability?.packages[p.id]?.quota.length ? t('why.quota', { limits: availability.packages[p.id].quota.map((x) => t(`quota.${x as 'vcpu'}`)).join(', ') }) : null;
  const orderable = packages.filter((p) => !blocked(p));
  // The advisor's starting size, and the cheapest orderable package that meets it.
  const need = want ? needs(want.w, want.traffic, image?.minDiskGb ?? 0) : null;
  const advice = need ? pick(orderable, need) : null;
  const recommended = advice?.pkg?.id ?? null;
  const bestValue = orderable.length > 1 ? orderable.reduce((a, b) => (Number(a.priceMonthly) / a.vcpu <= Number(b.priceMonthly) / b.vcpu ? a : b)).id : null;
  const taken = new Set(mine.map((m) => m.name));
  const suggest = () => { const base = slug(image?.name.split(/\s/)[0] ?? 'server'); let n = 1; while (taken.has(`${base}-${n}`)) n++; return `${base}-${n}`; };
  const couponOk = quote.data?.coupon && 'code' in quote.data.coupon ? quote.data.coupon : null;
  const couponError = quote.data?.coupon && 'error' in quote.data.coupon ? quote.data.coupon.error : undefined;
  const nameTaken = !!d.name && taken.has(d.name);
  const nameOk = hostnameSchema.safeParse(d.name).success && !nameTaken;
  // What still stands between the user and the order, each with the section that fixes it (the API requires all of them).
  const missing = [
    !d.imageId && { key: 'image', at: t('location') },
    !ready && { key: 'plan', at: t('kind') },
    !nameOk && { key: 'name', at: t('access') },
    !d.sshKeyIds.length && { key: 'keys', at: t('access') },
  ].filter((m): m is { key: 'image' | 'plan' | 'name' | 'keys'; at: string } => !!m);
  const canCreate = ready && !missing.length && quote.data && !quote.data.quota.exceeded.length && quote.data.capacityAvailable && !couponError;
  const jump = (title: string) => document.querySelector(`[data-section="${CSS.escape(title)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const steps = [
    { label: t('steps.location'), done: !!d.poolId && !!d.imageId, at: t('location') },
    { label: t('steps.plan'), done: ready, at: t('kind') },
    { label: t('steps.access'), done: nameOk && d.sshKeyIds.length > 0, at: t('access') },
    { label: t('steps.review'), done: !!canCreate, at: '' },
  ];
  const pkg = catalog.packages.find((p) => p.id === d.packageId);
  const application = catalog.applications.find((a) => a.id === d.applicationId);
  const custom = pool?.custom;
  const money = (v: string | number, currency: string) => format.number(Number(v), { style: 'currency', currency });
  const gb = (mb: number) => format.number(mb / 1024, { maximumFractionDigits: 1 });
  const quoteField = (name: string) => field(quote.error?.fields?.[name]) ?? field(failure?.fields?.[name]);

  async function create() {
    setFailure(undefined); setNameError(undefined);
    if (!hostnameSchema.safeParse(d.name).success) { setNameError(field('INVALID_HOSTNAME')); return; }
    if (taken.has(d.name)) { setNameError(field('NAME_TAKEN')); return; }
    setBusy(true);
    try {
      const out = await apiFetch<{ serverId: string; passwordReplaced?: boolean; invoiceId?: string; awaitingPayment?: boolean }>('/servers', { method: 'POST', body: { ...body, name: d.name, sshKeyIds: d.sshKeyIds, firewallIds, ...(rootPassword && { rootPassword }) }, headers: { 'idempotency-key': intent.key() } });
      if (out.passwordReplaced) toast.info(t('passwordReplaced'));
      intent.reset(); d.clear(); setRootPassword(''); queryClient.invalidateQueries({ queryKey: ['tasks'] });
      if (out.awaitingPayment && out.invoiceId) { toast.info(t('payToStart')); router.push(`/billing/invoices/${out.invoiceId}`); } else router.push(`/servers/${out.serverId}`);
    } catch (e) {
      setFailure({ ...(e as ApiError), text: error(e) });
      if ((e as ApiError).code !== 'NETWORK') intent.reset();
    } finally { setBusy(false); }
  }

  return <>
    <PageHeader title={t('title')} description={t('customNote')}/>
    <ol className="mb-6 flex flex-wrap items-center gap-2" aria-label={t('steps.label')}>
      {steps.map((st, i) => <li key={st.label} className="flex items-center gap-2">
        <button type="button" onClick={() => st.at ? jump(st.at) : document.getElementById('order-summary')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          className="flex items-center gap-2 rounded-full pr-2 hover:bg-default focus-visible:outline-2 focus-visible:outline-accent">
        <motion.span animate={{ scale: st.done ? [1, 1.15, 1] : 1 }} transition={{ duration: 0.3 }}
          className={`grid size-7 place-items-center rounded-full text-xs font-semibold ${st.done ? 'bg-success text-success-foreground' : 'bg-default text-muted'}`}>
          {st.done ? <I name="check" size={14}/> : i + 1}</motion.span>
        <span className={`text-sm ${st.done ? 'text-foreground' : 'text-muted'}`}>{st.label}</span></button>
        {i < steps.length - 1 && <span aria-hidden className="mx-1 hidden h-px w-8 bg-separator sm:block"/>}
      </li>)}
    </ol>
    {d.cloneFrom && <div className="mb-6"><Notice tone="accent" title={t('clone.title', { name: d.cloneName })}>{t('clone.help')}{' '}
      <button type="button" className="font-medium text-accent hover:underline" onClick={() => d.set({ cloneFrom: '', cloneName: '' })}>{t('clone.stop')}</button></Notice></div>}
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-6">
        <Section title={t('location')}>
          {catalog.locations.length > 0 && <div className="mb-4"><LocationPicker locations={catalog.locations} pools={catalog.pools} poolId={d.poolId}
            onPool={(v) => d.set({ poolId: v, packageId: '' })}/></div>}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {!catalog.locations.length && <SelectInput label={t('location')} value={d.poolId} onChange={(v) => d.set({ poolId: v, packageId: '' })}
              options={catalog.pools.map((p) => ({ id: p.id, label: p.location ? `${p.name} · ${p.location}` : p.name }))}/>}
            <SelectInput label={t('image')} value={d.imageId} onChange={(v) => d.set({ imageId: v })} error={quoteField('imageId')}
              options={catalog.images.map((i) => ({ id: i.id, label: i.name, description: (i as { own?: boolean }).own ? t('ownImage') : i.family }))}/>
            <SelectInput label={t('project')} value={d.projectId} onChange={(v) => d.set({ projectId: v })}
              options={[{ id: '', label: '–' }, ...projects.map((p) => ({ id: p.id, label: p.name }))]}/>
          </div>
        </Section>

        <Section title={t('kind')}>
          <RadioGroup aria-label={t('kind')} value={d.type} onChange={(v) => d.set({ type: v as 'package' | 'custom' })} orientation="horizontal" className="mb-4">
            <Radio value="package"><Radio.Content><Radio.Control><Radio.Indicator/></Radio.Control>{t('package')}</Radio.Content></Radio>
            <Radio value="custom" isDisabled={!custom}><Radio.Content><Radio.Control><Radio.Indicator/></Radio.Control>{t('custom')}{!custom && ` (${t('noCustom')})`}</Radio.Content></Radio>
          </RadioGroup>
          <WorkloadAdvisor want={want} onWant={setWant} need={need} recommended={d.type === 'package' ? recommended : null} enough={d.type === 'package' ? !!advice?.enough : true}
            applyLabel={d.type === 'package' ? (recommended ? t('advisor.choose') : '') : custom ? t('advisor.apply') : ''}
            onApply={() => { if (d.type === 'package' && recommended) d.set({ packageId: recommended }); else if (custom && need) d.set(snap(need, custom)); }}/>
          {d.type === 'package' && <RadioGroup aria-label={t('package')} value={d.packageId} onChange={(v) => d.set({ packageId: v })} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {packages.map((p) => <Radio key={p.id} value={p.id} isDisabled={!!blocked(p)} aria-label={t('packageOption', { name: p.name, vcpu: p.vcpu, memory: gb(p.memoryMb), disk: p.diskGb, price: money(p.priceMonthly, p.currency) })}
              className="group relative rounded-xl border border-border p-4 transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md data-[disabled=true]:translate-y-0 data-[disabled=true]:opacity-60 data-[disabled=true]:shadow-none data-[selected=true]:border-accent data-[selected=true]:bg-accent-soft">
              {bestValue === p.id && <span className="absolute -top-2.5 right-3 rounded-full bg-success px-2 py-0.5 text-[10px] font-semibold uppercase text-success-foreground">{t('bestValue')}</span>}
              {recommended === p.id && <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="absolute -top-2.5 left-3 inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase text-accent-foreground"><I name="wand-sparkles" size={10}/>{t('advisor.recommended')}</motion.span>}
              <Radio.Content className="flex w-full items-start gap-3">
                <Radio.Control className="mt-0.5"><Radio.Indicator/></Radio.Control>
                <span className="flex flex-col gap-1">
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-xs text-muted">{t('shape', { vcpu: p.vcpu, memory: gb(p.memoryMb), disk: p.diskGb })}</span>
                  <span className="text-lg font-semibold tabular-nums">{money(p.priceMonthly, p.currency)}<span className="text-xs font-normal text-muted"> / {t('perMonth')}</span></span>
                  <span className="text-[11px] tabular-nums text-muted">{t('perVcpu', { price: money(Number(p.priceMonthly) / p.vcpu, p.currency) })}</span>
                  {blocked(p) && <span className="flex items-center gap-1 text-xs text-warning"><I name="triangle-alert" size={12}/>{blocked(p)}</span>}
                </span>
              </Radio.Content>
            </Radio>)}
          </RadioGroup>}
          {d.type === 'custom' && custom && <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <NumberInput label="vCPU" value={d.vcpu} onChange={(v) => d.set({ vcpu: v ?? custom.cpuMin })} minValue={custom.cpuMin} maxValue={custom.cpuMax} step={custom.cpuStep}
              error={quoteField('vcpu')} help={t('range', { min: custom.cpuMin, max: custom.cpuMax, step: custom.cpuStep })}/>
            <NumberInput label="RAM (MB)" value={d.memoryMb} onChange={(v) => d.set({ memoryMb: v ?? custom.memoryMinMb })} minValue={custom.memoryMinMb} maxValue={custom.memoryMaxMb} step={custom.memoryStepMb}
              error={quoteField('memoryMb')} help={t('range', { min: custom.memoryMinMb, max: custom.memoryMaxMb, step: custom.memoryStepMb })}/>
            <NumberInput label={t('disk')} value={d.diskGb} onChange={(v) => d.set({ diskGb: v ?? custom.diskMinGb })} minValue={custom.diskMinGb} maxValue={custom.diskMaxGb} step={custom.diskStepGb}
              error={quoteField('diskGb')} help={t('range', { min: custom.diskMinGb, max: custom.diskMaxGb, step: custom.diskStepGb })}/>
          </div>}
        </Section>

        <Section title={t('access')}>
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-2">
              <TextInput format="serverName" className="flex-1" label={t('name')} value={d.name} onChange={(v) => { d.set({ name: v.toLowerCase() }); setNameError(undefined); }} help={t('nameHelp')}
                error={nameError ?? (nameTaken ? field('NAME_TAKEN') : d.name && !nameOk ? field('INVALID_HOSTNAME') : undefined) ?? quoteField('name')} autoComplete="off" spellCheck={false}/>
              <Button className="mt-6" variant="secondary" onPress={() => { d.set({ name: suggest() }); setNameError(undefined); }}><I name="sparkles" size={16}/>{t('suggest')}</Button>
            </div>
            {keys.length === 0 ? <Notice tone="warning">{t('noKeys')} <ButtonLink href="/account" size="sm" variant="secondary" className="ml-2">{t('manageKeys')}</ButtonLink></Notice>
              : <CheckboxList label={t('sshKeys')} value={d.sshKeyIds} onChange={(v) => d.set({ sshKeyIds: v })} error={quoteField('sshKeyIds')}
                  options={keys.map((k) => ({ id: k.id, label: k.name }))}/>}
            {image?.family === 'esxi' && <Notice tone="default">{t('esxiNote')}</Notice>}
            <div className="flex items-start gap-2">
              <TextInput className="flex-1" label={t('rootPassword')} type="password" value={rootPassword} onChange={setRootPassword} autoComplete="new-password" maxLength={128}
                help={t('rootPasswordHelp')} error={quoteField('rootPassword')}/>
              <Button className="mt-6" variant="secondary" onPress={() => { const p = strongPassword(); setRootPassword(p); void navigator.clipboard?.writeText(p).catch(() => undefined); toast.success(t('passwordGenerated')); }}>
                <I name="wand-sparkles" size={16}/>{t('generate')}</Button>
              {rootPassword && <Copy className="mt-6" text={rootPassword} label={t('rootPassword')}/>}
            </div>
            {rootPassword && <div className="pt-2"><Strength password={rootPassword}/></div>}
            {pool && pool.extraIpv4Max > 0 && <NumberInput label={t('extraIpv4')} value={Math.min(d.extraIpv4 ?? 0, pool.extraIpv4Max)} onChange={(v) => d.set({ extraIpv4: v ?? 0 })} minValue={0} maxValue={pool.extraIpv4Max}
              error={quoteField('extraIpv4')} help={t('extraIpv4Help', { max: pool.extraIpv4Max, price: money(pool.extraIpv4Price, quote.data?.price.currency ?? 'EUR') })}/>}
            {pool?.ipv6 && <p className="flex items-center gap-2 text-sm text-muted"><I name="globe" size={14}/>{t('ipv6Included')}</p>}
            {catalog.applications.length > 0 && <SelectInput label={t('application')} value={d.applicationId} onChange={(v) => d.set({ applicationId: v })} error={quoteField('applicationId')}
              help={t('applicationHelp')} options={[{ id: '', label: t('noApplication') }, ...catalog.applications.map((a) => {
                const shape = quote.data?.shape;
                // Why an application cannot go on this server (the API checks again).
                const why = !a.available ? t('why.appNoLicense') : image && image.family !== 'linux' ? t('why.appLinux')
                  : shape && (shape.memoryMb < a.minMemoryMb || shape.diskGb < a.minDiskGb) ? t('why.appShape', { memory: gb(a.minMemoryMb), disk: a.minDiskGb }) : null;
                return { id: a.id, label: Number(a.priceMonthly) ? `${a.name} · +${money(a.priceMonthly, quote.data?.price.currency ?? 'EUR')}` : a.name, description: why ?? (a.description || undefined), isDisabled: !!why && a.id !== d.applicationId };
              })]}/>}
            {firewalls.length > 0 && <CheckboxList label={tf('title')} value={firewallIds} onChange={setFirewallIds} error={quoteField('firewallIds')}
              help={tf('orderHelp')} options={firewalls.map((f) => ({ id: f.id, label: f.name }))}/>}
          </div>
        </Section>
      </div>

      <aside id="order-summary" className="scroll-mt-28 lg:sticky lg:top-20 lg:self-start">
        <Card>
          <Card.Header><Card.Title className="text-base font-semibold">{t('summary')}</Card.Title></Card.Header>
          <Card.Content className="flex flex-col gap-3 text-sm">
            {!ready ? <p className="text-muted">{t('choosePlan')}</p>
              : quote.isPending ? <p className="flex items-center gap-2 text-muted"><Spinner size="sm" color="current"/>{t('pricing')}</p>
              : quote.error ? <p role="alert" className="text-danger">{error(quote.error)}</p>
              : quote.data && <motion.div key={quote.data.price.monthly} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} className="quote flex flex-col gap-2">
                  <p>{t('shape', { vcpu: quote.data.shape.vcpu, memory: gb(quote.data.shape.memoryMb), disk: quote.data.shape.diskGb })}</p>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                    {([[t('location'), pool ? [pool.name, pool.location].filter(Boolean).join(' · ') : '–'], [t('image'), image?.name ?? '–'],
                      [t('steps.plan'), d.type === 'custom' ? t('custom') : pkg?.name ?? '–'], [t('name'), d.name || '–'],
                      ...((d.extraIpv4 ?? 0) > 0 ? [[t('extraIpv4'), String(d.extraIpv4)]] : []), ...(application ? [[t('application'), application.name]] : []),
                      ...(firewallIds.length ? [[tf('title'), String(firewallIds.length)]] : [])] as [string, string][]).map(([k, v]) =>
                      <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="truncate text-right font-medium" title={v}>{v}</dd></div>)}
                  </dl>
                  <Separator/>
                  {hourly && <RadioGroup aria-label={t('cycle.label')} value={d.billingCycle} onChange={(v) => d.set({ billingCycle: v as 'monthly' | 'hourly' })} orientation="horizontal">
                    <Radio value="monthly"><Radio.Content><Radio.Control><Radio.Indicator/></Radio.Control>{t('cycle.monthly')}</Radio.Content></Radio>
                    <Radio value="hourly"><Radio.Content><Radio.Control><Radio.Indicator/></Radio.Control>{t('cycle.hourly')}</Radio.Content></Radio>
                  </RadioGroup>}
                  {hourly && d.billingCycle === 'hourly' ? <>
                    <p className="text-2xl font-semibold tabular-nums">{t('cycle.perHour', { price: format.number(Number(quote.data.price.monthly) / 730, { style: 'currency', currency: quote.data.price.currency, maximumFractionDigits: 4 }) })}</p>
                    <p className="text-xs text-muted">{t('cycle.hourlyHelp', { hours: hourly.minHours, max: money(quote.data.price.monthly, quote.data.price.currency) })}</p>
                    {(() => { const cur = quote.data.price.currency;
                      const fromBalance = billing?.enabled ? billing.balance.find((b) => b.currency === cur)?.amount : undefined;
                      const left = Number(hourly.available.find((a) => a.currency === cur)?.amount ?? fromBalance ?? 0);
                      const need = Number(quote.data.price.monthly) / 730 * hourly.minHours;
                      return left < need ? <p className="flex items-start gap-1.5 text-warning"><I name="wallet" size={15} className="mt-0.5 shrink-0"/>{t('cycle.topUp', { need: money(need.toFixed(2), quote.data.price.currency) })}{' '}
                        <NextLink href="/billing?tab=balance" className="font-medium text-accent hover:underline">{t('cycle.topUpLink')}</NextLink></p> : null; })()}
                  </> : couponOk ? <div>
                    <p className="text-2xl font-semibold tabular-nums">{t('monthly', { price: money(couponOk.monthly, quote.data.price.currency) })}</p>
                    <p className="text-xs text-muted"><s className="tabular-nums">{money(quote.data.price.monthly, quote.data.price.currency)}</s>{' · '}
                      {couponOk.periods === null ? t('coupon.always') : t('coupon.periods', { n: couponOk.periods, after: money(quote.data.price.monthly, quote.data.price.currency) })}</p>
                  </div> : <div><p className="text-2xl font-semibold tabular-nums">{t('monthly', { price: money(quote.data.price.monthly, quote.data.price.currency) })}</p>
                    <p className="text-xs text-muted">{t('yearly', { price: money(Number(quote.data.price.monthly) * 12, quote.data.price.currency) })}</p></div>}
                  {billing?.enabled && d.billingCycle !== 'hourly' && (couponOk
                    ? <p className="flex items-center gap-2 text-success"><I name="ticket" size={15}/><span className="font-medium">{t('coupon.applied', { code: couponOk.code })}</span>
                      <Button size="sm" variant="ghost" onPress={() => { setCoupon(''); setCouponInput(''); }}>{t('coupon.remove')}</Button></p>
                    : <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setCoupon(couponInput.trim().toUpperCase()); }}>
                      <TextInput className="min-w-0 flex-1" label={t('coupon.label')} value={couponInput} onChange={(v) => { setCouponInput(v.toUpperCase()); if (couponError) setCoupon(''); }} maxLength={32} spellCheck={false}
                        error={coupon && couponError ? field(couponError) : undefined}/>
                      <Button type="submit" variant="secondary" isDisabled={!couponInput.trim()}>{t('coupon.apply')}</Button>
                    </form>)}
                  {quote.data.budget && quote.data.budget.state !== 'ok' && <p className={`flex items-start gap-1.5 text-sm ${quote.data.budget.state === 'over' ? 'text-danger' : 'text-warning'}`}>
                    <I name="wallet" size={15} className="mt-0.5 shrink-0"/>{t(quote.data.budget.state === 'over' ? 'budgetOver' : 'budgetNear', { monthly: money(quote.data.budget.monthly, quote.data.budget.currency), amount: money(quote.data.budget.amount, quote.data.budget.currency) })}</p>}
                  {quote.data.quota.exceeded.length > 0 && <p className="text-danger">{t('quotaExceeded', { limits: quote.data.quota.exceeded.map((x) => t(`quota.${x as 'vcpu'}`)).join(', ') })}</p>}
                  {!quote.data.capacityAvailable && <p className="text-danger">{t('noCapacity')}</p>}
                </motion.div>}
            {failure && <p role="alert" className="text-danger">{failure.text}</p>}
          </Card.Content>
          <Card.Footer className="flex flex-col items-stretch gap-3">
            {missing.length > 0 && <ul aria-label={t('missing.title')} className="flex flex-col gap-1 text-sm">
              <li className="text-xs font-medium uppercase tracking-wider text-muted">{t('missing.title')}</li>
              {missing.map((m) => <li key={m.key}><button type="button" onClick={() => jump(m.at)} className="flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left text-warning hover:bg-default focus-visible:outline-2 focus-visible:outline-accent">
                <I name="circle-alert" size={14} className="shrink-0"/>{t(`missing.${m.key}`)}<I name="arrow-right" size={13} className="ml-auto shrink-0"/></button></li>)}
            </ul>}
            <Button fullWidth size="lg" isDisabled={!canCreate} isPending={busy} onPress={create}><I name="rocket" size={18}/>{t('create')}</Button>
          </Card.Footer>
        </Card>
      </aside>
    </div>
  </>;
}

