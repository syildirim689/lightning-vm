"use client";
// The customer's virtual data centers: usage, the servers inside, bulk power actions, and a server of any shape
// that still fits.
import { Button, Card, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../components/icon';
import { ButtonLink, CheckboxList, ConfirmButton, Empty, Mono, NumberInput, PageHeader, SelectInput, StatusChip, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../lib/api';
import { useApiQuery } from '../../../lib/query';
import { useMe } from '../../../lib/me';
import { can } from '../../../lib/permissions';
import { UsageBar, type Vdc } from '../admin/catalog/vdc-ui';
import { useIntentKey } from '../servers-ui';

type Mine = Vdc & { servers: { id: string; name: string; state: string; vcpu: number; memoryMb: number; diskGb: number; address: string | null }[];
  images: { id: string; name: string; family: string; minDiskGb: number }[] };
const key = ['vdcs'];

function NewServer({ vdc, onDone }: { vdc: Mine; onDone: () => void }) {
  const t = useTranslations('Vdc');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const keys = useApiQuery<{ keys: { id: string; name: string }[] }>(['ssh-keys'], '/ssh-keys').data?.keys ?? [];
  const left = { vcpu: vdc.vcpu - vdc.used.vcpu, memoryGb: (vdc.memoryMb - vdc.used.memoryMb) / 1024, diskGb: vdc.diskGb - vdc.used.diskGb };
  const [v, setV] = useState({ name: '', imageId: vdc.images[0]?.id ?? '', vcpu: Math.min(1, left.vcpu), memoryGb: Math.min(1, left.memoryGb), diskGb: Math.min(20, left.diskGb), sshKeyIds: [] as string[] });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const intent = useIntentKey();
  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFields({});
    try {
      await apiFetch('/servers', { method: 'POST', headers: { 'idempotency-key': intent.key() },
        body: { vdcId: vdc.id, name: v.name, imageId: v.imageId, vcpu: v.vcpu, memoryMb: Math.round(v.memoryGb * 1024), diskGb: v.diskGb, sshKeyIds: v.sshKeyIds } });
      intent.reset(); toast.success(t('creating')); client.invalidateQueries({ queryKey: key }); client.invalidateQueries({ queryKey: ['tasks'] }); onDone();
    } catch (err) { setFields((err as ApiError).fields ?? {}); toast.danger(error(err)); if ((err as ApiError).code !== 'NETWORK') intent.reset(); } finally { setBusy(false); }
  }
  return <form className="flex flex-col gap-4" noValidate onSubmit={create}>
    <p className="text-sm text-muted">{t('leftNow', { vcpu: left.vcpu, memory: left.memoryGb, disk: left.diskGb, servers: vdc.maxServers - vdc.used.servers })}</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <TextInput label={t('serverName')} value={v.name} onChange={(x) => setV({ ...v, name: x.toLowerCase() })} error={field(fields.name)} isRequired spellCheck={false} placeholder="web-1"/>
      <SelectInput label={t('image')} value={v.imageId} onChange={(x) => setV({ ...v, imageId: x })} error={field(fields.imageId)} options={vdc.images.map((i) => ({ id: i.id, label: i.name, description: i.family }))}/>
      <NumberInput label="vCPU" value={v.vcpu} onChange={(x) => setV({ ...v, vcpu: x ?? 1 })} minValue={1} maxValue={Math.max(1, left.vcpu)} error={field(fields.vcpu)}/>
      <NumberInput label="RAM (GB)" value={v.memoryGb} onChange={(x) => setV({ ...v, memoryGb: x ?? 1 })} minValue={0.5} maxValue={Math.max(0.5, left.memoryGb)} step={0.25} error={field(fields.memoryMb)}/>
      <NumberInput label={`${t('disk')} (GB)`} value={v.diskGb} onChange={(x) => setV({ ...v, diskGb: x ?? 10 })} minValue={10} maxValue={Math.max(10, left.diskGb)} step={10} error={field(fields.diskGb)}/>
    </div>
    <CheckboxList label={t('sshKeys')} value={v.sshKeyIds} onChange={(x) => setV({ ...v, sshKeyIds: x })} error={field(fields.sshKeyIds)} options={keys.map((k) => ({ id: k.id, label: k.name }))}/>
    <div className="flex justify-end gap-2"><Button variant="tertiary" onPress={onDone}>{t('cancel')}</Button><Button type="submit" isPending={busy}><I name="rocket" size={16}/>{t('create')}</Button></div>
  </form>;
}

export default function VdcPage() {
  const me = useMe();
  const t = useTranslations('Vdc');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ vdcs: Mine[] }>(key, '/vdcs', { refetchInterval: 10_000 });
  const [adding, setAdding] = useState<Mine | null>(null);
  async function bulk(v: Mine, action: string) {
    try {
      const r = await apiFetch<{ started: unknown[] }>(`/vdcs/${v.id}/actions`, { method: 'POST', body: { action }, headers: { 'idempotency-key': crypto.randomUUID() } });
      toast.success(t('bulkStarted', { n: r.started.length })); client.invalidateQueries({ queryKey: ['tasks'] }); client.invalidateQueries({ queryKey: key });
    } catch (e) { toast.danger(error(e)); }
  }
  return <>
    <PageHeader title={t('myTitle')} description={t('myIntro')}/>
    {!q.data ? <p role="status" className="text-sm text-muted">{t('loading')}</p>
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
            <Button size="sm" variant="secondary" isDisabled={!v.servers.length} onPress={() => bulk(v, 'power_on')}><I name="play" size={14}/>{t('allOn')}</Button>
            <Button size="sm" variant="secondary" isDisabled={!v.servers.length} onPress={() => bulk(v, 'shutdown')}><I name="power" size={14}/>{t('allShutdown')}</Button>
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
        {v.servers.length > 0 && <ul className="divide-y divide-separator rounded-xl border border-border">
          {v.servers.map((s) => <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
            <span className="font-medium">{s.name}</span>
            <StatusChip tone={s.state === 'ready' ? 'success' : s.state === 'error' ? 'danger' : 'accent'}>{s.state}</StatusChip>
            <span className="text-xs text-muted">{s.vcpu} vCPU · {s.memoryMb / 1024} GB · {s.diskGb} GB</span>
            {s.address && <Mono>{s.address}</Mono>}
            <ButtonLink size="sm" variant="ghost" className="ml-auto" href={`/servers/${s.id}`}>{t('open')}</ButtonLink>
          </li>)}
        </ul>}
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
