"use client";
// The customer's virtual data centers: usage, the servers inside, bulk power actions, and a server of any shape
// that still fits.
import { Button, Card, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../components/icon';
import { ButtonLink, CheckboxList, ConfirmButton, Empty, Mono, Notice, NumberInput, PageHeader, SelectInput, StatusChip, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../lib/api';
import { useApiQuery } from '../../../lib/query';
import { useMe } from '../../../lib/me';
import { can } from '../../../lib/permissions';
import { UsageBar, type Vdc } from '../admin/catalog/vdc-ui';
import { useIntentKey } from '../servers-ui';
import { fold } from '../../../lib/note-line';
import { Copy } from '../server-extras';

type Mine = Vdc & { servers: { id: string; name: string; state: string; vcpu: number; memoryMb: number; diskGb: number; address: string | null }[];
  images: { id: string; name: string; family: string; minDiskGb: number }[] };
const key = ['vdcs'];

function NewServer({ vdc, onDone }: { vdc: Mine; onDone: () => void }) {
  const t = useTranslations('Vdc');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const keys = useApiQuery<{ keys: { id: string; name: string }[] }>(['ssh-keys'], '/ssh-keys').data?.keys ?? [];
  const left = { vcpu: vdc.vcpu - vdc.used.vcpu, memoryGb: (vdc.memoryMb - vdc.used.memoryMb) / 1024, diskGb: vdc.diskGb - vdc.used.diskGb };
  // A free name from the data centre's own ("lab-3"), so the form can be sent as it opens; it is just a suggestion.
  const suggest = (base: string) => { const taken = new Set(vdc.servers.map((x) => x.name)); let n = vdc.servers.length + 1; while (taken.has(`${base}-${n}`)) n++; return `${base}-${n}`; };
  const base = vdc.name.toLocaleLowerCase('en').normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server';
  const [v, setV] = useState({ name: suggest(base), imageId: vdc.images[0]?.id ?? '', vcpu: Math.min(1, left.vcpu), memoryGb: Math.min(1, left.memoryGb), diskGb: Math.min(20, left.diskGb), sshKeyIds: [] as string[] });
  // With a single saved key it is ticked for you, until you change the selection yourself.
  const [keysTouched, setKeysTouched] = useState(false);
  const sshKeyIds = keysTouched ? v.sshKeyIds : keys.length === 1 ? [keys[0]!.id] : v.sshKeyIds;
  const minDisk = Math.max(10, vdc.images.find((i) => i.id === v.imageId)?.minDiskGb ?? 10);
  const family = (f: string) => (f === 'linux' ? 'Linux' : f === 'windows' ? 'Windows' : f === 'esxi' ? 'VMware ESXi' : f);
  // One click to a common shape: the smallest that boots this image, half of what is left, or all of it.
  const quarter = (gb: number) => Math.max(0.5, Math.floor(gb * 4) / 4);
  const shapes = {
    small: { vcpu: 1, memoryGb: Math.min(1, quarter(left.memoryGb)), diskGb: Math.min(Math.max(20, minDisk), left.diskGb) },
    half: { vcpu: Math.max(1, Math.floor(left.vcpu / 2)), memoryGb: quarter(left.memoryGb / 2), diskGb: Math.min(left.diskGb, Math.max(minDisk, Math.floor(left.diskGb / 20) * 10)) },
    all: { vcpu: Math.max(1, left.vcpu), memoryGb: quarter(left.memoryGb), diskGb: left.diskGb },
  };
  const picked = (Object.keys(shapes) as (keyof typeof shapes)[]).find((k) => shapes[k].vcpu === v.vcpu && shapes[k].memoryGb === v.memoryGb && shapes[k].diskGb === v.diskGb);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const intent = useIntentKey();
  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFields({});
    try {
      await apiFetch('/servers', { method: 'POST', headers: { 'idempotency-key': intent.key() },
        body: { vdcId: vdc.id, name: v.name, imageId: v.imageId, vcpu: v.vcpu, memoryMb: Math.round(v.memoryGb * 1024), diskGb: v.diskGb, sshKeyIds } });
      intent.reset(); toast.success(t('creating')); client.invalidateQueries({ queryKey: key }); client.invalidateQueries({ queryKey: ['tasks'] }); onDone();
    } catch (err) { setFields((err as ApiError).fields ?? {}); toast.danger(error(err)); if ((err as ApiError).code !== 'NETWORK') intent.reset(); } finally { setBusy(false); }
  }
  return <form className="flex flex-col gap-4" noValidate onSubmit={create}>
    <p className="text-sm text-muted">{t('leftNow', { vcpu: left.vcpu, memory: left.memoryGb, disk: left.diskGb, servers: vdc.maxServers - vdc.used.servers })}</p>
    {left.diskGb < minDisk && <Notice tone="warning">{t('diskTooSmall', { min: minDisk, left: left.diskGb })}</Notice>}
    <div role="radiogroup" aria-label={t('shape')} className="flex flex-wrap gap-2">
      {(Object.keys(shapes) as (keyof typeof shapes)[]).map((k) => <button key={k} type="button" role="radio" aria-checked={picked === k} onClick={() => setV({ ...v, ...shapes[k] })}
        className={`flex flex-col items-start rounded-xl border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent ${picked === k ? 'border-accent bg-accent-soft/40' : 'border-border hover:bg-default'}`}>
        <span className="font-medium">{t(`shapes.${k}`)}</span>
        <span className="text-xs tabular-nums text-muted">{t('shapeValue', { vcpu: shapes[k].vcpu, memory: shapes[k].memoryGb, disk: shapes[k].diskGb })}</span>
      </button>)}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <TextInput label={t('serverName')} value={v.name} onChange={(x) => setV({ ...v, name: x.toLowerCase() })} error={field(fields.name)} isRequired spellCheck={false} placeholder="web-1"
        help={vdc.servers.some((x) => x.name === v.name.trim()) ? t('nameTaken') : undefined}/>
      <SelectInput label={t('image')} value={v.imageId} onChange={(x) => { const min = Math.max(10, vdc.images.find((i) => i.id === x)?.minDiskGb ?? 10); setV({ ...v, imageId: x, diskGb: v.diskGb < min ? Math.min(min, Math.max(min, left.diskGb)) : v.diskGb }); }}
        error={field(fields.imageId)} options={vdc.images.map((i) => ({ id: i.id, label: i.name, description: `${family(i.family)} · ≥ ${Math.max(10, i.minDiskGb)} GB` }))}/>
      <NumberInput label="vCPU" value={v.vcpu} onChange={(x) => setV({ ...v, vcpu: x ?? 1 })} minValue={1} maxValue={Math.max(1, left.vcpu)} error={field(fields.vcpu)}/>
      <NumberInput label="RAM (GB)" value={v.memoryGb} onChange={(x) => setV({ ...v, memoryGb: x ?? 1 })} minValue={0.5} maxValue={Math.max(0.5, left.memoryGb)} step={0.25} error={field(fields.memoryMb)}/>
      <NumberInput label={`${t('disk')} (GB)`} value={v.diskGb} onChange={(x) => setV({ ...v, diskGb: x ?? 10 })} minValue={minDisk} maxValue={Math.max(minDisk, left.diskGb)} step={10} error={field(fields.diskGb)} help={t('diskMin', { min: minDisk })}/>
    </div>
    <CheckboxList label={t('sshKeys')} value={sshKeyIds} onChange={(x) => { setKeysTouched(true); setV({ ...v, sshKeyIds: x }); }} error={field(fields.sshKeyIds)} options={keys.map((k) => ({ id: k.id, label: k.name }))}
      help={keys.length ? undefined : t('noKeysHelp')}/>
    <div className="flex justify-end gap-2"><Button variant="tertiary" onPress={onDone}>{t('cancel')}</Button><Button type="submit" isPending={busy} isDisabled={!v.name.trim() || left.diskGb < minDisk}><I name="rocket" size={16}/>{t('create')}</Button></div>
  </form>;
}

export default function VdcPage() {
  const me = useMe();
  const t = useTranslations('Vdc');
  const ts = useTranslations('Servers');
  const format = useFormatter();
  const { error } = useErrorText();
  const [find, setFind] = useState('');
  const client = useQueryClient();
  const q = useApiQuery<{ vdcs: Mine[] }>(key, '/vdcs', { refetchInterval: 10_000 });
  const [adding, setAdding] = useState<Mine | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function bulk(v: Mine, action: string) {
    if (busy) return;
    setBusy(`${v.id}:${action}`);
    try {
      const r = await apiFetch<{ started: unknown[] }>(`/vdcs/${v.id}/actions`, { method: 'POST', body: { action }, headers: { 'idempotency-key': crypto.randomUUID() } });
      toast.success(t('bulkStarted', { n: r.started.length })); client.invalidateQueries({ queryKey: ['tasks'] }); client.invalidateQueries({ queryKey: key });
    } catch (e) { toast.danger(error(e)); } finally { setBusy(null); }
  }
  return <>
    <PageHeader title={t('myTitle')} description={t('myIntro')}/>
    {!q.data ? <div role="status" aria-label={t('loading')} className="h-48 animate-pulse rounded-3xl bg-default/50"/>
      : !q.data.vdcs.length ? <Empty icon={<I name="building-2" size={28}/>} title={t('none')}>{t('noneHelp')}
        {/* The way to one: staff set it up in the catalog, a customer asks support. */}
        <span className="mt-3 flex justify-center">{can(me?.permissions, 'catalog.manage')
          ? <ButtonLink href="/admin/catalog?tab=vdcs" variant="secondary"><I name="plus" size={16}/>{t('createOne')}</ButtonLink>
          : <ButtonLink href="/support?new=1" variant="secondary"><I name="life-buoy" size={16}/>{t('askOne')}</ButtonLink>}</span></Empty>
      : <div className="flex flex-col gap-6">{q.data.vdcs.map((v) => <Card key={v.id}><Card.Content className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-lg font-semibold"><I name="building-2" size={18} className="text-accent"/>{v.name}{!v.active && <StatusChip tone="warning">{t('inactive')}</StatusChip>}</p>
            <p className="text-sm text-muted">{[v.location || v.poolName, t('monthly', { price: format.number(Number(v.priceMonthly), { style: 'currency', currency: v.currency }) })].join(' · ')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" isDisabled={!v.active || v.used.servers >= v.maxServers} onPress={() => setAdding(v)}><I name="plus" size={14}/>{t('newServer')}</Button>
            <Button size="sm" variant="secondary" isDisabled={!v.servers.length} isPending={busy === `${v.id}:power_on`} onPress={() => bulk(v, 'power_on')}><I name="play" size={14}/>{t('allOn')}</Button>
            <ConfirmButton size="sm" variant="secondary" icon={<I name="power" size={14}/>} label={t('allShutdown')} title={t('allShutdown')} body={t('allShutdownConfirm', { n: v.servers.length })}
              confirmLabel={t('allShutdown')} cancelLabel={t('cancel')} isDisabled={!v.servers.length} onConfirm={() => bulk(v, 'shutdown')}/>
            <ConfirmButton size="sm" variant="danger-soft" icon={<I name="rotate-ccw" size={14}/>} label={t('allReset')} title={t('allReset')} body={t('allResetConfirm', { n: v.servers.length })}
              confirmLabel={t('allReset')} cancelLabel={t('cancel')} isDisabled={!v.servers.length} onConfirm={() => bulk(v, 'reset')}/>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <UsageBar label="vCPU" used={v.used.vcpu} total={v.vcpu}/>
          <UsageBar label="RAM" used={v.used.memoryMb / 1024} total={v.memoryMb / 1024} unit="GB"/>
          <UsageBar label={t('disk')} used={v.used.diskGb} total={v.diskGb} unit="GB"/>
          <UsageBar label={t('servers')} used={v.used.servers} total={v.maxServers}/>
        </div>
        {v.servers.length > 0 && <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
            <span>{t('serverSummary', { n: v.servers.length, ready: v.servers.filter((s) => s.state === 'ready').length, failed: v.servers.filter((s) => s.state === 'error' || s.state === 'missing').length })}</span>
            {v.servers.length > 5 && <TextInput className="w-full sm:w-64" label={t('findServer')} value={find} onChange={setFind} placeholder={t('findServerHint')} spellCheck={false}/>}
          </div>
          <ul className="divide-y divide-separator rounded-xl border border-border">
          {v.servers.filter((s) => !find.trim() || fold(`${s.name} ${s.address ?? ''}`).includes(fold(find.trim()))).map((s) => <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
            <span className="font-medium">{s.name}</span>
            <StatusChip tone={s.state === 'ready' ? 'success' : s.state === 'error' || s.state === 'missing' ? 'danger' : 'accent'}>{ts(`state.${s.state as 'ready'}`)}</StatusChip>
            <span className="text-xs text-muted">{s.vcpu} vCPU · {format.number(s.memoryMb / 1024, { maximumFractionDigits: 2 })} GB · {s.diskGb} GB</span>
            {s.address && <span className="flex items-center gap-1"><Mono>{s.address}</Mono><Copy text={s.address} label={`${s.name} IP`}/></span>}
            <ButtonLink size="sm" variant="ghost" className="ml-auto" href={`/servers/${s.id}`}>{t('open')}</ButtonLink>
          </li>)}
        </ul></div>}
      </Card.Content></Card>)}</div>}
    <Modal.Backdrop isOpen={!!adding} onOpenChange={(o) => !o && setAdding(null)}>
      <Modal.Container size="lg" scroll="inside"><Modal.Dialog className="sm:max-w-2xl">
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading>{t('newServerIn', { name: adding?.name ?? '' })}</Modal.Heading></Modal.Header>
        <Modal.Body>{adding && <NewServer vdc={adding} onDone={() => setAdding(null)}/>}</Modal.Body>
      </Modal.Dialog></Modal.Container>
    </Modal.Backdrop>
  </>;
}
