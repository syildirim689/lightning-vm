"use client";
import { Button, Card, Radio, RadioGroup, Separator, Spinner } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
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
  pools: { id: string; name: string; location: string; custom: Custom | null }[]; images: { id: string; name: string; family: string; minDiskGb: number }[] };
type Quote = { shape: { vcpu: number; memoryMb: number; diskGb: number }; price: { monthly: string; currency: string }; quota: { exceeded: string[] }; capacityAvailable: boolean };
type Project = { id: string; name: string };

// Builds, prices and places an order. Every value is validated again by the API.
export default function Order() {
  const t = useTranslations('Order');
  const format = useFormatter();
  const { error, field } = useErrorText();
  const router = useRouter();
  const intent = useIntentKey();
  const d = useOrder();
  const keys = useSshKeys();
  const catalog = useApiQuery<Catalog>(['catalog'], '/catalog').data;
  const projects = useApiQuery<{ projects: Project[] }>(['projects'], '/projects').data?.projects ?? [];
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
  const ready = !!d.poolId && (d.type === 'custom' ? !!pool?.custom : !!d.packageId);
  const quote = useQuery<Quote, ApiError>({
    queryKey: ['quote', body], enabled: ready,
    queryFn: () => apiFetch<Quote>('/catalog/quote', { method: 'POST', body }),
  });

  if (!catalog) return <p role="status" className="text-sm text-muted">…</p>;
  if (!catalog.pools.length) return <><PageHeader title={t('title')}/><Empty icon={<I name="map-pin" size={28}/>} title={t('nothingOffered')}/></>;
  const packages = catalog.packages.filter((p) => p.poolIds.includes(d.poolId));
  const custom = pool?.custom;
  const money = (v: string | number, currency: string) => format.number(Number(v), { style: 'currency', currency });
  const gb = (mb: number) => format.number(mb / 1024, { maximumFractionDigits: 1 });
  const quoteField = (name: string) => field(quote.error?.fields?.[name]) ?? field(failure?.fields?.[name]);
  const canCreate = ready && quote.data && !quote.data.quota.exceeded.length && quote.data.capacityAvailable;

  async function create() {
    setFailure(undefined); setNameError(undefined);
    if (!hostnameSchema.safeParse(d.name).success) { setNameError(field('INVALID_HOSTNAME')); return; }
    setBusy(true);
    try {
      const out = await apiFetch<{ serverId: string }>('/servers', { method: 'POST', body: { ...body, name: d.name, sshKeyIds: d.sshKeyIds }, headers: { 'idempotency-key': intent.key() } });
      intent.reset(); d.clear(); router.push(`/servers/${out.serverId}`);
    } catch (e) {
      setFailure({ ...(e as ApiError), text: error(e) });
      if ((e as ApiError).code !== 'NETWORK') intent.reset();
    } finally { setBusy(false); }
  }

  return <>
    <PageHeader title={t('title')} description={t('customNote')}/>
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
            {packages.map((p) => <Radio key={p.id} value={p.id} aria-label={t('packageOption', { name: p.name, vcpu: p.vcpu, memory: gb(p.memoryMb), disk: p.diskGb, price: money(p.priceMonthly, p.currency) })}
              className="group rounded-xl border border-border p-4 transition-colors duration-150 data-[selected=true]:border-accent data-[selected=true]:bg-accent-soft">
              <Radio.Content className="flex w-full items-start gap-3">
                <Radio.Control className="mt-0.5"><Radio.Indicator/></Radio.Control>
                <span className="flex flex-col gap-1">
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-xs text-muted">{t('shape', { vcpu: p.vcpu, memory: gb(p.memoryMb), disk: p.diskGb })}</span>
                  <span className="text-lg font-semibold tabular-nums">{money(p.priceMonthly, p.currency)}<span className="text-xs font-normal text-muted"> / {t('perMonth')}</span></span>
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
            <TextInput label={t('name')} value={d.name} onChange={(v) => { d.set({ name: v }); setNameError(undefined); }} help={t('nameHelp')} error={nameError ?? quoteField('name')} autoComplete="off" spellCheck={false}/>
            {keys.length === 0 ? <Notice tone="warning">{t('noKeys')} <ButtonLink href="/account" size="sm" variant="secondary" className="ml-2">{t('manageKeys')}</ButtonLink></Notice>
              : <CheckboxList label={t('sshKeys')} value={d.sshKeyIds} onChange={(v) => d.set({ sshKeyIds: v })} error={quoteField('sshKeyIds')}
                  options={keys.map((k) => ({ id: k.id, label: k.name }))}/>}
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

