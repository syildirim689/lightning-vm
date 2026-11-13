"use client";
// Changing a server after the order: a bigger or smaller size (the disk only grows), and a fresh install from another
// image. Both are operations (task list, history, notification); the price shown is the API's own quote.
import { Button, toast } from '@heroui/react';
import { useUnits } from '../../lib/units';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../components/icon';
import { CheckboxInput, ConfirmButton, NumberInput, Notice, Section, SelectInput, TextInput } from '../../components/ui';
import { apiFetch, type ApiError, useErrorText } from '../../lib/api';
import { useApiQuery } from '../../lib/query';
import type { Server } from './servers-ui';

type Custom = { cpuMin: number; cpuMax: number; cpuStep: number; memoryMinMb: number; memoryMaxMb: number; memoryStepMb: number; diskMinGb: number; diskMaxGb: number; diskStepGb: number };
type Catalog = { packages: { id: string; name: string; vcpu: number; memoryMb: number; diskGb: number; priceMonthly: string; currency: string; poolIds: string[]; imageIds: string[] }[];
  pools: { id: string; custom: Custom | null }[]; images: { id: string; name: string; family: string; minDiskGb: number }[] };
type Quote = { shape: { vcpu: number; memoryMb: number; diskGb: number }; priceMonthly: string; currency: string; chargeNow: string; periodEnd: string | null };

async function send(path: string, body: object) {
  return apiFetch<{ invoiceId?: string }>(path, { method: 'POST', body, headers: { 'idempotency-key': crypto.randomUUID() } });
}

export function ServerResize({ server, busy }: { server: Server; busy: boolean }) {
  const { memory } = useUnits();
  const t = useTranslations('ServerChange');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const catalog = useApiQuery<Catalog>(['catalog'], '/catalog').data;
  const custom = catalog?.pools.find((p) => p.id === server.poolId)?.custom ?? null;
  const packages = (catalog?.packages ?? []).filter((p) => p.poolIds.includes(server.poolId) && p.id !== server.packageId);
  const [type, setType] = useState<'package' | 'custom'>(packages.length || !custom ? 'package' : 'custom');
  const [packageId, setPackageId] = useState('');
  const [shape, setShape] = useState({ vcpu: server.vcpu, memoryMb: server.memoryMb, diskGb: server.diskGb });
  const [sending, setSending] = useState(false);
  const body = type === 'package' ? { type, packageId } : { type, ...shape };
  const unchanged = type === 'custom' && shape.vcpu === server.vcpu && shape.memoryMb === server.memoryMb && shape.diskGb === server.diskGb;
  const ready = type === 'package' ? !!packageId : !unchanged;
  const quote = useQuery<Quote, ApiError>({ queryKey: ['resize-quote', server.id, body], enabled: ready, retry: false,
    queryFn: () => apiFetch<Quote>(`/servers/${server.id}/resize/quote`, { method: 'POST', body }) });
  const money = (v: string) => format.number(Number(v), { style: 'currency', currency: quote.data?.currency ?? server.currency });
  if (!catalog || (!packages.length && !custom)) return null;
  const q = quote.data;
  const shrinks = q && (q.shape.vcpu < server.vcpu || q.shape.memoryMb < server.memoryMb);

  async function apply() {
    setSending(true);
    try {
      const out = await send(`/servers/${server.id}/resize`, body);
      toast.success(out.invoiceId ? t('startedInvoice') : t('started'));
      client.invalidateQueries({ queryKey: ['servers'] }); client.invalidateQueries({ queryKey: ['tasks'] }); client.invalidateQueries({ queryKey: ['billing'] });
    } catch (e) { toast.danger(error(e)); } finally { setSending(false); }
  }

  return <Section title={t('resize.title')} description={t('resize.help')}>
    <div className="flex flex-col gap-4">
      {packages.length > 0 && custom && <SelectInput className="max-w-xs" label={t('resize.kind')} value={type} onChange={(v) => setType(v as 'package' | 'custom')}
        options={[{ id: 'package', label: t('resize.package') }, { id: 'custom', label: t('resize.custom') }]}/>}
      {type === 'package' ? <SelectInput className="max-w-md" label={t('resize.package')} value={packageId} onChange={setPackageId}
        options={packages.map((p) => ({ id: p.id, label: p.name, description: `${p.vcpu} vCPU · ${p.memoryMb / 1024} GB · ${p.diskGb} GB · ${format.number(Number(p.priceMonthly), { style: 'currency', currency: p.currency })}`,
          isDisabled: p.diskGb < server.diskGb }))}/>
        : custom && <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <NumberInput label="vCPU" value={shape.vcpu} onChange={(v) => setShape({ ...shape, vcpu: v ?? server.vcpu })} minValue={custom.cpuMin} maxValue={custom.cpuMax} step={custom.cpuStep}/>
          <NumberInput label="RAM (MB)" value={shape.memoryMb} onChange={(v) => setShape({ ...shape, memoryMb: v ?? server.memoryMb })} minValue={custom.memoryMinMb} maxValue={custom.memoryMaxMb} step={custom.memoryStepMb}/>
          <NumberInput label={t('resize.disk')} value={shape.diskGb} onChange={(v) => setShape({ ...shape, diskGb: v ?? server.diskGb })} minValue={Math.max(custom.diskMinGb, server.diskGb)} maxValue={custom.diskMaxGb} step={custom.diskStepGb}
            help={t('resize.diskGrowOnly', { gb: server.diskGb })}/>
        </div>}
      {ready && quote.error && <Notice tone="warning">{error(quote.error)}</Notice>}
      {q && <dl className="grid gap-3 rounded-xl border border-border p-3 text-sm sm:grid-cols-3">
        <div><dt className="text-muted">{t('resize.now')}</dt><dd className="mt-0.5">{server.vcpu} vCPU · {memory(server.memoryMb)} · {server.diskGb} GB · {money(server.priceMonthly)}</dd></div>
        <div><dt className="text-muted">{t('resize.after')}</dt><dd className="mt-0.5 font-medium">{q.shape.vcpu} vCPU · {memory(q.shape.memoryMb)} · {q.shape.diskGb} GB · {money(q.priceMonthly)}</dd>
          {Number(q.priceMonthly) !== Number(server.priceMonthly) && <dd className={`text-xs font-medium ${Number(q.priceMonthly) > Number(server.priceMonthly) ? 'text-warning' : 'text-success'}`}>
            {t('resize.diff', { sign: Number(q.priceMonthly) > Number(server.priceMonthly) ? '+' : '−', amount: money(String(Math.abs(Number(q.priceMonthly) - Number(server.priceMonthly)))) })}</dd>}</div>
        <div><dt className="text-muted">{t('resize.chargeNow')}</dt><dd className="mt-0.5 font-medium">{Number(q.chargeNow) > 0 ? money(q.chargeNow) : t('resize.nothingNow')}</dd>
          {Number(q.chargeNow) > 0 && q.periodEnd && <dd className="text-xs text-muted">{t('resize.until', { date: format.dateTime(new Date(q.periodEnd), { dateStyle: 'medium' }) })}</dd>}</div>
      </dl>}
      {q && <p className="text-xs text-muted">{server.powerState === 'poweredOn' ? t('resize.restart') : t('resize.offline')}{shrinks ? ` ${t('resize.shrinkNote')}` : ''}</p>}
      {unchanged && <p className="text-xs text-muted">{t('resize.unchanged')}</p>}
      <div><ConfirmButton icon={<I name="gauge" size={16}/>} label={t('resize.apply')} isDisabled={!q || !ready || busy || sending || server.state !== 'ready'}
        title={t('resize.confirmTitle', { name: server.name })}
        body={q ? `${q.shape.vcpu} vCPU · ${memory(q.shape.memoryMb)} · ${q.shape.diskGb} GB · ${money(q.priceMonthly)}${t('resize.perMonth')}. ${Number(q.chargeNow) > 0 ? t('resize.confirmCharge', { amount: money(q.chargeNow) }) : t('resize.nothingNow')}. ${server.powerState === 'poweredOn' ? t('resize.restart') : t('resize.offline')}` : ''}
        confirmLabel={t('resize.apply')} cancelLabel={t('resize.cancel')} onConfirm={apply}/></div>
    </div>
  </Section>;
}

export function ServerReinstall({ server, busy, own }: { server: Server; busy: boolean; own: boolean }) {
  const t = useTranslations('ServerChange');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const catalog = useApiQuery<Catalog>(['catalog'], '/catalog').data;
  const keys = useApiQuery<{ keys: { id: string; name: string }[] }>(['ssh-keys'], '/ssh-keys').data?.keys ?? [];
  const pkg = catalog?.packages.find((p) => p.id === server.packageId);
  const images = (catalog?.images ?? []).filter((i) => i.minDiskGb <= server.diskGb && (!pkg?.imageIds.length || pkg.imageIds.includes(i.id)));
  const [imageId, setImageId] = useState(server.imageId);
  const [newKeys, setNewKeys] = useState(false);
  const [keyId, setKeyId] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  if (!catalog) return null;

  async function run() {
    setSending(true); setFields({});
    try {
      await send(`/servers/${server.id}/reinstall`, { imageId, confirm, ...(newKeys && keyId && { sshKeyIds: [keyId] }) });
      toast.success(t('reinstall.started'));
      setConfirm('');
      client.invalidateQueries({ queryKey: ['servers'] }); client.invalidateQueries({ queryKey: ['tasks'] });
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setSending(false); }
  }

  return <Section title={t('reinstall.title')} description={t('reinstall.help')} className="border border-danger/30">
    <div className="flex flex-col gap-4">
      <SelectInput className="max-w-md" label={t('reinstall.image')} value={imageId} onChange={setImageId} error={field(fields.imageId)}
        options={images.map((i) => ({ id: i.id, label: i.name, description: i.id === server.imageId ? t('reinstall.current') : (i as { own?: boolean }).own ? t('reinstall.own') : undefined }))}/>
      {own && <CheckboxInput label={t('reinstall.newKey')} isSelected={newKeys} onChange={setNewKeys} help={t('reinstall.keysHelp')}/>}
      {newKeys && <SelectInput className="max-w-md" label={t('reinstall.key')} value={keyId} onChange={setKeyId} error={field(fields.sshKeyIds)}
        options={keys.map((k) => ({ id: k.id, label: k.name }))}/>}
      <Notice tone="danger">{t('reinstall.warning')}</Notice>
      <div className="flex flex-wrap items-end gap-3">
        <TextInput className="min-w-64 flex-1" label={t('reinstall.confirm', { name: server.name })} value={confirm} onChange={setConfirm} autoComplete="off" error={field(fields.confirm)}/>
        <Button variant="danger" isDisabled={confirm !== server.name || !imageId || busy || sending || server.locked || (newKeys && !keyId)} isPending={sending} onPress={run}>
          <I name="refresh-cw" size={16}/>{t('reinstall.button')}</Button>
      </div>
      {server.locked && <p className="text-xs text-muted">{t('reinstall.locked')}</p>}
    </div>
  </Section>;
}
