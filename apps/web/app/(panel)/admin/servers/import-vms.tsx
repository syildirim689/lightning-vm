"use client";
// Admin → Servers → Import: VMs found in vCenter but made outside the panel become servers of a customer. The VM keeps
// running; it is renamed to the panel's name for it. Refresh the inventory (VMware page) to see new VMs here.
import { Button, ComboBox, Description, Input, Label, ListBox, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../../components/icon';
import { DataTable, Empty, Notice, SelectInput, StatusChip, TextInput } from '../../../../components/ui';
import { apiFetch, type ApiError, useErrorText } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Vm = { moref: string; name: string; powerState: string | null; vcpu: number | null; memoryMb: number | null; guest: string | null; storageGb: number };
type Candidates = { vms: Vm[]; pools: { id: string; name: string }[] };

function ImportForm({ vm, data, connectionId, onDone }: { vm: Vm; data: Candidates; connectionId: string; onDone: () => void }) {
  const t = useTranslations('Import');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const images = (useApiQuery<{ images: { id: string; name: string; family: string; connectionId: string }[] }>(['admin', 'images'], '/admin/images').data?.images ?? []).filter((i) => i.connectionId === connectionId);
  const users = useApiQuery<{ users: { id: string; email: string; name: string }[] }>(['admin', 'users'], '/admin/users').data?.users ?? [];
  const packages = useApiQuery<{ packages: { currency: string }[] }>(['catalog', 'packages'], '/admin/packages').data?.packages ?? [];
  // Currencies the catalog sells in come first; the one most packages use is the default.
  const counts = new Map<string, number>(); packages.forEach((x) => counts.set(x.currency.trim(), (counts.get(x.currency.trim()) ?? 0) + 1));
  const catalogCurrencies = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const currencies = [...new Set([...catalogCurrencies, 'EUR', 'USD', 'TRY', 'GBP'])];
  const hostname = vm.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'server';
  const [v, setV] = useState({ ownerEmail: '', name: hostname, poolId: data.pools[0]?.id ?? '', imageId: '', address: '', priceMonthly: '', currency: '' });
  // Smart defaults until chosen: the image whose family matches the VM's guest OS (or the only one), and the catalog's currency.
  const windows = /windows/i.test(vm.guest ?? '');
  const guess = images.length === 1 ? images[0] : images.find((i) => (windows ? i.family === 'windows' : i.family === 'linux'));
  const imageId = v.imageId || guess?.id || '';
  const currency = v.currency || catalogCurrencies[0] || 'EUR';
  const needle = v.ownerEmail.trim().toLowerCase();
  const people = users.filter((u) => !needle || `${u.email} ${u.name}`.toLowerCase().includes(needle)).slice(0, 50);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (x: string) => setV({ ...v, [k]: x });
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFields({});
    try {
      await apiFetch('/admin/import', { method: 'POST', body: { ...v, imageId, currency, vmMoref: vm.moref, priceMonthly: v.priceMonthly.replace(',', '.') } });
      toast.success(t('done', { name: v.name }));
      client.invalidateQueries({ queryKey: ['admin'] }); client.invalidateQueries({ queryKey: ['import'] });
      onDone();
    } catch (err) { setFields((err as ApiError).fields ?? {}); toast.danger(error(err)); } finally { setBusy(false); }
  }
  return <form onSubmit={save} noValidate className="mt-3 grid gap-3 rounded-xl border border-accent/40 bg-accent-soft/40 p-3 sm:grid-cols-2 lg:grid-cols-3">
    {/* Type to search the accounts; any e-mail can still be typed. */}
    <ComboBox className="w-full" allowsCustomValue inputValue={v.ownerEmail} onInputChange={set('ownerEmail')} items={people} menuTrigger="input" isInvalid={!!fields.ownerEmail}
      onSelectionChange={(k) => { const u = users.find((x) => x.id === k); if (u) setV({ ...v, ownerEmail: u.email }); }}>
      <Label>{t('owner')}</Label>
      <ComboBox.InputGroup><Input type="email" autoComplete="off"/><ComboBox.Trigger/></ComboBox.InputGroup>
      <Description className={fields.ownerEmail ? 'text-danger' : undefined}>{fields.ownerEmail ? field(fields.ownerEmail) : t('ownerHelp')}</Description>
      <ComboBox.Popover>
        <ListBox>{(u: { id: string; email: string; name: string }) => <ListBox.Item id={u.id} textValue={u.email}>
          <span className="flex min-w-0 flex-col"><span className="truncate">{u.email}</span>{u.name && <span className="truncate text-xs text-muted">{u.name}</span>}</span><ListBox.ItemIndicator/></ListBox.Item>}</ListBox>
      </ComboBox.Popover>
    </ComboBox>
    <TextInput label={t('name')} value={v.name} onChange={set('name')} error={field(fields.name)}/>
    <SelectInput label={t('pool')} value={v.poolId} onChange={set('poolId')} error={field(fields.poolId)} options={data.pools.map((p) => ({ id: p.id, label: p.name }))}/>
    <SelectInput label={t('image')} value={imageId} onChange={set('imageId')} error={field(fields.imageId)} help={t('imageHelp')} options={images.map((i) => ({ id: i.id, label: i.name }))}/>
    <TextInput label={t('address')} value={v.address} onChange={set('address')} error={field(fields.address)} help={t('addressHelp')} placeholder="203.0.113.10"/>
    <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
      <TextInput label={t('price')} value={v.priceMonthly} onChange={set('priceMonthly')} error={field(fields.priceMonthly)} placeholder="0.00"/>
      <SelectInput label={t('currency')} value={currency} onChange={set('currency')} options={currencies.map((c) => ({ id: c, label: c }))}/>
    </div>
    <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3">
      <Button type="submit" isPending={busy} isDisabled={!v.ownerEmail || !imageId || !v.poolId}><I name="download" size={16}/>{t('submit')}</Button>
      <Button variant="ghost" onPress={onDone}>{t('cancel')}</Button>
    </div>
  </form>;
}

export function ImportVms() {
  const t = useTranslations('Import');
  const conns = useApiQuery<{ connections: { id: string; name: string; kind: string }[] }>(['admin', 'vmware'], '/admin/vmware/connections').data?.connections ?? [];
  const [connectionId, setConnectionId] = useState('');
  const id = connectionId || conns[0]?.id || '';
  const q = useApiQuery<Candidates>(['import', id], id ? `/admin/import/candidates?connectionId=${id}` : null);
  const [open, setOpen] = useState<string>();
  const vms = q.data?.vms ?? [];
  return <div className="flex flex-col gap-4">
    <p className="max-w-3xl text-sm text-muted">{t('help')}</p>
    {conns.length > 1 && <SelectInput className="max-w-xs" label={t('connection')} value={id} onChange={setConnectionId} options={conns.map((c) => ({ id: c.id, label: c.name }))}/>}
    {q.data && !q.data.pools.length && <Notice tone="warning">{t('noPool')}</Notice>}
    {!vms.length ? <Empty icon={<I name="server" size={20}/>} title={t('empty')}>{t('emptyHelp')}</Empty>
      : <DataTable label={t('title')} rows={vms} rowKey={(v) => v.moref} minWidth={640}
          columns={[{ id: 'name', label: t('vm') }, { id: 'power', label: t('power') }, { id: 'size', label: t('size') }, { id: 'act', label: <span className="sr-only">{t('submit')}</span> }]}
          cells={(v) => [<div key="n" className="flex flex-col">
              <span className="font-medium">{v.name}</span><span className="text-xs text-muted">{v.guest ?? v.moref}</span>
              {open === v.moref && q.data && <ImportForm vm={v} data={q.data} connectionId={id} onDone={() => setOpen(undefined)}/>}</div>,
            <StatusChip key="p" tone={v.powerState === 'poweredOn' ? 'success' : 'default'}>{v.powerState === 'poweredOn' ? t('on') : t('off')}</StatusChip>,
            `${v.vcpu ?? '?'} vCPU · ${v.memoryMb ? v.memoryMb / 1024 : '?'} GB · ${Math.ceil(v.storageGb)} GB`,
            open === v.moref ? null : <Button key="i" size="sm" variant="secondary" isDisabled={!q.data?.pools.length} onPress={() => setOpen(v.moref)}><I name="download" size={14}/>{t('submit')}</Button>]}/>}
  </div>;
}
