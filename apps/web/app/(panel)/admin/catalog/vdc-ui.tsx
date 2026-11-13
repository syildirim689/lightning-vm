"use client";
// Virtual data centers in the catalog: a customer's allocation in a pool, its monthly price, and how much of
// it is in use.
import { Button, Meter, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../../components/icon';
import { ConfirmButton, CurrencyInput, DataTable, FieldGroup, NumberInput, SelectInput, StatusChip, SwitchInput, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { useApiAction, useApiQuery } from '../../../../lib/query';

export type Vdc = { id: string; name: string; ownerId: string; owner: string; poolId: string; poolName: string; location: string; vcpu: number; memoryMb: number; diskGb: number;
  maxServers: number; priceMonthly: string; currency: string; active: boolean; used: { servers: number; vcpu: number; memoryMb: number; diskGb: number } };
const key = ['catalog', 'vdcs'];

export function UsageBar({ label, used, total, unit = '' }: { label: string; used: number; total: number; unit?: string }) {
  const format = useFormatter();
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const n = (v: number) => format.number(v, { maximumFractionDigits: 1 });
  return <div className="flex flex-col gap-1">
    <div className="flex justify-between text-xs"><span className="text-muted">{label}</span><span className="tabular-nums">{n(used)} / {n(total)}{unit && ` ${unit}`}</span></div>
    <Meter aria-label={label} value={pct} size="sm" color={pct > 90 ? 'danger' : pct > 75 ? 'warning' : 'success'}><Meter.Track><Meter.Fill/></Meter.Track></Meter>
  </div>;
}

export function VdcAdmin({ pools }: { pools: { id: string; name: string }[] }) {
  const t = useTranslations('Vdc');
  const format = useFormatter();
  const rows = useApiQuery<{ vdcs: Vdc[] }>(key, '/admin/vdcs').data?.vdcs ?? [];
  const users = useApiQuery<{ users: { id: string; email: string }[] }>(['admin', 'users'], '/admin/users').data?.users ?? [];
  const [editing, setEditing] = useState<Vdc | 'new' | null>(null);
  const remove = useApiAction((id: string) => apiFetch(`/admin/vdcs/${id}`, { method: 'DELETE' }), { invalidate: [key], success: t('removed') });
  return <>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-3xl text-sm text-muted">{t('explain')}</p>
      <Button onPress={() => setEditing('new')} isDisabled={!pools.length}><I name="building-2" size={16}/>{t('new')}</Button>
    </div>
    <DataTable label={t('title')} rows={rows} rowKey={(v) => v.id} empty={t('empty')} minWidth={900}
      columns={[{ id: 'n', label: t('name') }, { id: 'p', label: t('pool') }, { id: 'u', label: t('usage') }, { id: 'pr', label: t('price') }, { id: 'a', label: <span className="sr-only">{t('actions')}</span> }]}
      cells={(v) => [
        <span key="n" className="flex flex-col"><span className="font-medium">{v.name}</span><span className="text-xs text-muted">{v.owner}</span>{!v.active && <StatusChip tone="warning">{t('inactive')}</StatusChip>}</span>,
        <span key="p" className="flex flex-col text-sm"><span>{v.poolName}</span>{v.location && <span className="text-xs text-muted">{v.location}</span>}</span>,
        <span key="u" className="grid min-w-64 grid-cols-2 gap-x-4 gap-y-1.5">
          <UsageBar label="vCPU" used={v.used.vcpu} total={v.vcpu}/>
          <UsageBar label="RAM" used={v.used.memoryMb / 1024} total={v.memoryMb / 1024} unit="GB"/>
          <UsageBar label={t('disk')} used={v.used.diskGb} total={v.diskGb} unit="GB"/>
          <UsageBar label={t('servers')} used={v.used.servers} total={v.maxServers}/>
        </span>,
        format.number(Number(v.priceMonthly), { style: 'currency', currency: v.currency }),
        <span key="a" className="flex gap-1">
          <Button size="sm" variant="ghost" onPress={() => setEditing(v)}><I name="pencil" size={14}/>{t('edit')}</Button>
          <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={t('remove')} title={`${t('remove')}: ${v.name}`} body={t('removeConfirm')}
            confirmLabel={t('remove')} cancelLabel={t('cancel')} isDisabled={v.used.servers > 0} onConfirm={() => remove.mutateAsync(v.id).then(() => undefined)}/>
        </span>]}/>
    <Modal.Backdrop isOpen={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
      <Modal.Container size="lg" scroll="inside"><Modal.Dialog className="sm:max-w-2xl">
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading>{editing === 'new' ? t('new') : t('editTitle')}</Modal.Heading></Modal.Header>
        <Modal.Body>{editing && <VdcForm vdc={editing === 'new' ? null : editing} pools={pools} users={users} onDone={() => setEditing(null)}/>}</Modal.Body>
      </Modal.Dialog></Modal.Container>
    </Modal.Backdrop>
  </>;
}

function VdcForm({ vdc, pools, users, onDone }: { vdc: Vdc | null; pools: { id: string; name: string }[]; users: { id: string; email: string }[]; onDone: () => void }) {
  const t = useTranslations('Vdc');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const [v, setV] = useState({ ownerId: vdc?.ownerId ?? '', poolId: vdc?.poolId ?? pools[0]?.id ?? '', name: vdc?.name ?? '', vcpu: vdc?.vcpu ?? 8, memoryGb: (vdc?.memoryMb ?? 16384) / 1024,
    diskGb: vdc?.diskGb ?? 200, maxServers: vdc?.maxServers ?? 10, priceMonthly: vdc?.priceMonthly ?? '', currency: vdc?.currency ?? 'EUR', active: vdc?.active ?? true });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K) => (x: (typeof v)[K]) => { setV((s) => ({ ...s, [k]: x })); setFields((f) => ({ ...f, [k]: '' })); };
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFields({});
    try {
      const body = { ...v, memoryMb: Math.round(v.memoryGb * 1024), priceMonthly: v.priceMonthly || '0' };
      await apiFetch(vdc ? `/admin/vdcs/${vdc.id}` : '/admin/vdcs', { method: vdc ? 'PUT' : 'POST', body });
      await client.invalidateQueries({ queryKey: ['catalog'] }); toast.success(t('saved')); onDone();
    } catch (err) { setFields((err as ApiError).fields ?? {}); toast.danger(error(err)); } finally { setBusy(false); }
  }
  return <form className="flex flex-col gap-4" noValidate onSubmit={save}>
    <FieldGroup title={t('identity')}>
      <TextInput maxLength={60} label={t('name')} value={v.name} onChange={set('name')} error={field(fields.name)} isRequired placeholder="Acme Production"/>
      <SelectInput label={t('owner')} value={v.ownerId} onChange={set('ownerId')} error={field(fields.ownerId)} isDisabled={!!vdc} options={users.map((u) => ({ id: u.id, label: u.email }))}/>
      <SelectInput label={t('pool')} value={v.poolId} onChange={set('poolId')} error={field(fields.poolId)} isDisabled={!!vdc} options={pools.map((p) => ({ id: p.id, label: p.name }))}/>
      <SwitchInput label={t('active')} isSelected={v.active} onChange={set('active')}/>
    </FieldGroup>
    <FieldGroup title={t('allocation')} description={t('allocationHelp')} cols={2}>
      <NumberInput label="vCPU" value={v.vcpu} onChange={(x) => set('vcpu')(x ?? 1)} minValue={1} error={field(fields.vcpu)}/>
      <NumberInput label="RAM (GB)" value={v.memoryGb} onChange={(x) => set('memoryGb')(x ?? 1)} minValue={0.5} step={0.5} error={field(fields.memoryMb)}/>
      <NumberInput label={`${t('disk')} (GB)`} value={v.diskGb} onChange={(x) => set('diskGb')(x ?? 10)} minValue={10} step={10} error={field(fields.diskGb)}/>
      <NumberInput label={t('maxServers')} value={v.maxServers} onChange={(x) => set('maxServers')(x ?? 1)} minValue={1} error={field(fields.maxServers)}/>
    </FieldGroup>
    <FieldGroup title={t('billing')} description={t('billingHelp')}>
      <TextInput format="money" label={t('price')} value={v.priceMonthly} onChange={set('priceMonthly')} error={field(fields.priceMonthly)} placeholder="199.00"/>
      <CurrencyInput label={t('currency')} value={v.currency} onChange={set('currency')} error={field(fields.currency)}/>
    </FieldGroup>
    <div className="sticky bottom-0 -mx-1 flex justify-end gap-2 border-t border-separator bg-overlay px-1 py-3">
      <Button variant="tertiary" onPress={onDone}>{t('cancel')}</Button>
      <Button type="submit" isPending={busy}><I name="check" size={16}/>{t('save')}</Button>
    </div>
  </form>;
}
