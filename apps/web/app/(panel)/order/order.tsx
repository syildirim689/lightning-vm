"use client";
import { Button, Card, Radio, RadioGroup, Separator, Spinner } from '@heroui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../components/icon';
import { ButtonLink, CheckboxList, Empty, Notice, NumberInput, PageHeader, Section, SelectInput, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../lib/api';
import { hostnameSchema, orderBody, useOrder } from '../../../lib/order-store';
import { useApiQuery } from '../../../lib/query';
import { useIntentKey, useSshKeys } from '../servers-ui';

type Custom = { cpuMin: number; cpuMax: number; cpuStep: number; memoryMinMb: number; memoryMaxMb: number; memoryStepMb: number; diskMinGb: number; diskMaxGb: number; diskStepGb: number; currency: string };
type Catalog = { packages: { id: string; name: string; vcpu: number; memoryMb: number; diskGb: number; priceMonthly: string; currency: string; poolIds: string[]; imageIds: string[] }[];
  pools: { id: string; name: string; location: string; custom: Custom | null; extraIpv4Max: number; extraIpv4Price: string; ipv6: boolean }[]; images: { id: string; name: string; family: string; minDiskGb: number }[] };
type Quote = { shape: { vcpu: number; memoryMb: number; diskGb: number }; price: { monthly: string; currency: string }; quota: { exceeded: string[] }; capacityAvailable: boolean };
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
  const queryClient = useQueryClient();
  const keys = useSshKeys();
  const tf = useTranslations('Firewalls');
  const firewalls = useApiQuery<{ firewalls: { id: string; name: string }[] }>(['firewalls'], '/firewalls').data?.firewalls ?? [];
  const [firewallIds, setFirewallIds] = useState<string[]>([]);
  const catalog = useApiQuery<Catalog>(['catalog'], '/catalog').data;
  const projects = useApiQuery<{ projects: Project[] }>(['projects'], '/projects').data?.projects ?? [];
  const mine = useApiQuery<{ servers: { name: string }[] }>(['servers'], '/servers').data?.servers ?? [];
  const availability = useApiQuery<Availability>(['availability', d.poolId], d.poolId ? `/catalog/availability?poolId=${d.poolId}` : null).data;
  const [failure, setFailure] = useState<ApiError & { text: string }>();
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string>();

  // First pool by default, and drop selections that no longer exist in the catalog.
  useEffect(() => {
    if (!catalog) return;
    if (!catalog.pools.some((p) => p.id === d.poolId)) d.set({ poolId: catalog.pools[0]?.id ?? '' });
    if (d.packageId && !catalog.packages.some((p) => p.id === d.packageId)) d.set({ packageId: '' });
  }, [catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = orderBody(d);
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
    : availability?.packages[p.id] && !availability.packages[p.id].capacity ? t('why.capacity')
    : availability?.packages[p.id]?.quota.length ? t('why.quota', { limits: availability.packages[p.id].quota.map((x) => t(`quota.${x as 'vcpu'}`)).join(', ') }) : null;
  const orderable = packages.filter((p) => !blocked(p));
  const bestValue = orderable.length > 1 ? orderable.reduce((a, b) => (Number(a.priceMonthly) / a.vcpu <= Number(b.priceMonthly) / b.vcpu ? a : b)).id : null;
  const taken = new Set(mine.map((m) => m.name));
  const suggest = () => { const base = slug(image?.name.split(/\s/)[0] ?? 'server'); let n = 1; while (taken.has(`${base}-${n}`)) n++; return `${base}-${n}`; };
  const canCreate = ready && quote.data && !quote.data.quota.exceeded.length && quote.data.capacityAvailable;
  const nameTaken = !!d.name && taken.has(d.name);
  const steps = [
    { label: t('steps.location'), done: !!d.poolId && !!d.imageId },
    { label: t('steps.plan'), done: ready },
    { label: t('steps.access'), done: hostnameSchema.safeParse(d.name).success && !taken.has(d.name) && d.sshKeyIds.length > 0 },
    { label: t('steps.review'), done: !!canCreate },
  ];
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
      const out = await apiFetch<{ serverId: string }>('/servers', { method: 'POST', body: { ...body, name: d.name, sshKeyIds: d.sshKeyIds, firewallIds }, headers: { 'idempotency-key': intent.key() } });
      intent.reset(); d.clear(); queryClient.invalidateQueries({ queryKey: ['tasks'] }); router.push(`/servers/${out.serverId}`);
    } catch (e) {
      setFailure({ ...(e as ApiError), text: error(e) });
      if ((e as ApiError).code !== 'NETWORK') intent.reset();
    } finally { setBusy(false); }
  }

  return <>
    <PageHeader title={t('title')} description={t('customNote')}/>
    <ol className="mb-6 flex flex-wrap items-center gap-2" aria-label={t('steps.label')}>
      {steps.map((st, i) => <li key={st.label} className="flex items-center gap-2">
        <motion.span animate={{ scale: st.done ? [1, 1.15, 1] : 1 }} transition={{ duration: 0.3 }}
          className={`grid size-7 place-items-center rounded-full text-xs font-semibold ${st.done ? 'bg-success text-success-foreground' : 'bg-default text-muted'}`}>
          {st.done ? <I name="check" size={14}/> : i + 1}</motion.span>
        <span className={`text-sm ${st.done ? 'text-foreground' : 'text-muted'}`}>{st.label}</span>
        {i < steps.length - 1 && <span aria-hidden className="mx-1 hidden h-px w-8 bg-separator sm:block"/>}
      </li>)}
    </ol>
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-6">
        <Section title={t('location')}>
          <div className="grid gap-4 md:grid-cols-3">
            <SelectInput label={t('location')} value={d.poolId} onChange={(v) => d.set({ poolId: v, packageId: '' })}
              options={catalog.pools.map((p) => ({ id: p.id, label: p.location ? `${p.name} · ${p.location}` : p.name }))}/>
            <SelectInput label={t('image')} value={d.imageId} onChange={(v) => d.set({ imageId: v })} error={quoteField('imageId')}
              options={catalog.images.map((i) => ({ id: i.id, label: i.name, description: i.family }))}/>
            <SelectInput label={t('project')} value={d.projectId} onChange={(v) => d.set({ projectId: v })}
              options={[{ id: '', label: '–' }, ...projects.map((p) => ({ id: p.id, label: p.name }))]}/>
          </div>
        </Section>

        <Section title={t('kind')}>
          <RadioGroup aria-label={t('kind')} value={d.type} onChange={(v) => d.set({ type: v as 'package' | 'custom' })} orientation="horizontal" className="mb-4">
            <Radio value="package"><Radio.Content><Radio.Control><Radio.Indicator/></Radio.Control>{t('package')}</Radio.Content></Radio>
            <Radio value="custom" isDisabled={!custom}><Radio.Content><Radio.Control><Radio.Indicator/></Radio.Control>{t('custom')}{!custom && ` (${t('noCustom')})`}</Radio.Content></Radio>
          </RadioGroup>
          {d.type === 'package' && <RadioGroup aria-label={t('package')} value={d.packageId} onChange={(v) => d.set({ packageId: v })} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {packages.map((p) => <Radio key={p.id} value={p.id} isDisabled={!!blocked(p)} aria-label={t('packageOption', { name: p.name, vcpu: p.vcpu, memory: gb(p.memoryMb), disk: p.diskGb, price: money(p.priceMonthly, p.currency) })}
              className="group relative rounded-xl border border-border p-4 transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md data-[disabled=true]:translate-y-0 data-[disabled=true]:opacity-60 data-[disabled=true]:shadow-none data-[selected=true]:border-accent data-[selected=true]:bg-accent-soft">
              {bestValue === p.id && <span className="absolute -top-2.5 right-3 rounded-full bg-success px-2 py-0.5 text-[10px] font-semibold uppercase text-success-foreground">{t('bestValue')}</span>}
              <Radio.Content className="flex w-full items-start gap-3">
                <Radio.Control className="mt-0.5"><Radio.Indicator/></Radio.Control>
                <span className="flex flex-col gap-1">
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-xs text-muted">{t('shape', { vcpu: p.vcpu, memory: gb(p.memoryMb), disk: p.diskGb })}</span>
                  <span className="text-lg font-semibold tabular-nums">{money(p.priceMonthly, p.currency)}<span className="text-xs font-normal text-muted"> / {t('perMonth')}</span></span>
                  {blocked(p) && <span className="flex items-center gap-1 text-xs text-warning"><I name="triangle-alert" size={12}/>{blocked(p)}</span>}
                </span>
              </Radio.Content>
            </Radio>)}
          </RadioGroup>}
          {d.type === 'custom' && custom && <div className="grid gap-4 md:grid-cols-3">
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
              <TextInput className="flex-1" label={t('name')} value={d.name} onChange={(v) => { d.set({ name: v.toLowerCase() }); setNameError(undefined); }} help={t('nameHelp')}
                error={nameError ?? (nameTaken ? field('NAME_TAKEN') : undefined) ?? quoteField('name')} autoComplete="off" spellCheck={false}/>
              <Button className="mt-6" variant="secondary" onPress={() => { d.set({ name: suggest() }); setNameError(undefined); }}><I name="sparkles" size={16}/>{t('suggest')}</Button>
            </div>
            {keys.length === 0 ? <Notice tone="warning">{t('noKeys')} <ButtonLink href="/account" size="sm" variant="secondary" className="ml-2">{t('manageKeys')}</ButtonLink></Notice>
              : <CheckboxList label={t('sshKeys')} value={d.sshKeyIds} onChange={(v) => d.set({ sshKeyIds: v })} error={quoteField('sshKeyIds')}
                  options={keys.map((k) => ({ id: k.id, label: k.name }))}/>}
            {pool && pool.extraIpv4Max > 0 && <NumberInput label={t('extraIpv4')} value={Math.min(d.extraIpv4 ?? 0, pool.extraIpv4Max)} onChange={(v) => d.set({ extraIpv4: v ?? 0 })} minValue={0} maxValue={pool.extraIpv4Max}
              error={quoteField('extraIpv4')} help={t('extraIpv4Help', { max: pool.extraIpv4Max, price: money(pool.extraIpv4Price, quote.data?.price.currency ?? 'EUR') })}/>}
            {pool?.ipv6 && <p className="flex items-center gap-2 text-sm text-muted"><I name="globe" size={14}/>{t('ipv6Included')}</p>}
            {firewalls.length > 0 && <CheckboxList label={tf('title')} value={firewallIds} onChange={setFirewallIds} error={quoteField('firewallIds')}
              help={tf('orderHelp')} options={firewalls.map((f) => ({ id: f.id, label: f.name }))}/>}
          </div>
        </Section>
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        <Card>
          <Card.Header><Card.Title className="text-base font-semibold">{t('summary')}</Card.Title></Card.Header>
          <Card.Content className="flex flex-col gap-3 text-sm">
            {!ready ? <p className="text-muted">{t('choosePlan')}</p>
              : quote.isPending ? <p className="flex items-center gap-2 text-muted"><Spinner size="sm" color="current"/>{t('pricing')}</p>
              : quote.error ? <p role="alert" className="text-danger">{error(quote.error)}</p>
              : quote.data && <motion.div key={quote.data.price.monthly} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} className="quote flex flex-col gap-2">
                  <p>{t('shape', { vcpu: quote.data.shape.vcpu, memory: gb(quote.data.shape.memoryMb), disk: quote.data.shape.diskGb })}</p>
                  <Separator/>
                  <p className="text-2xl font-semibold tabular-nums">{t('monthly', { price: money(quote.data.price.monthly, quote.data.price.currency) })}</p>
                  {quote.data.quota.exceeded.length > 0 && <p className="text-danger">{t('quotaExceeded', { limits: quote.data.quota.exceeded.map((x) => t(`quota.${x as 'vcpu'}`)).join(', ') })}</p>}
                  {!quote.data.capacityAvailable && <p className="text-danger">{t('noCapacity')}</p>}
                </motion.div>}
            {failure && <p role="alert" className="text-danger">{failure.text}</p>}
          </Card.Content>
          <Card.Footer>
            <Button fullWidth size="lg" isDisabled={!canCreate} isPending={busy} onPress={create}><I name="rocket" size={18}/>{t('create')}</Button>
          </Card.Footer>
        </Card>
      </aside>
    </div>
  </>;
}

