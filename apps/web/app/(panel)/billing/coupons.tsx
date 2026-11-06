"use client";
// Coupons (Admin → Billing → Coupons): codes customers enter when ordering; percent or a fixed amount off for the first
// invoices or all of them. A used coupon keeps its code and amount; it is deactivated rather than deleted.
import { Button, ProgressBar, SearchField, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../components/icon';
import { CheckboxInput, CheckboxList, ConfirmButton, DataTable, Section, SelectInput, StatusChip, SwitchInput, TextInput } from '../../../components/ui';
import { apiFetch, type ApiError, useErrorText } from '../../../lib/api';
import { useApiQuery } from '../../../lib/query';
import { downloadCsv } from '../../../lib/csv';
import { fold } from '../../../lib/note-line';

type Coupon = { id: string; code: string; kind: 'percent' | 'fixed'; value: string; currency: string | null; periods: number | null; maxUses: number | null; oncePerUser: boolean;
  newCustomers: boolean; packageIds: string[] | null; expiresAt: string | null; active: boolean; note: string | null; createdAt: string; uses: number; activeSubscriptions: number };
const blank = { code: '', kind: 'percent', value: '', currency: 'TRY', periods: '', maxUses: '', expiresAt: '', oncePerUser: true, newCustomers: false, packageIds: [] as string[], note: '' };
// A readable code: no 0/O or 1/I to mix up when it is read out or typed from a flyer.
const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

function NewCoupon({ onDone }: { onDone: () => void }) {
  const t = useTranslations('Coupons');
  const format = useFormatter();
  const { error, field } = useErrorText();
  const packages = useApiQuery<{ packages: { id: string; name: string }[] }>(['admin', 'packages'], '/admin/packages').data?.packages ?? [];
  const [v, setV] = useState(blank);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof blank>) => setV((x) => ({ ...x, ...patch }));
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFields({});
    try {
      await apiFetch('/admin/coupons', { method: 'POST', body: { code: v.code, kind: v.kind, value: v.value.replace(',', '.'), ...(v.kind === 'fixed' && { currency: v.currency }),
        periods: v.periods || null, maxUses: v.maxUses || null, expiresAt: v.expiresAt ? new Date(`${v.expiresAt}T23:59:59`).toISOString() : null,
        oncePerUser: v.oncePerUser, newCustomers: v.newCustomers, packageIds: v.packageIds, note: v.note } });
      toast.success(t('created', { code: v.code })); setV(blank); onDone();
    } catch (err) { setFields((err as ApiError).fields ?? {}); toast.danger(error(err)); } finally { setBusy(false); }
  }
  return <Section title={t('new')} description={t('newHelp')}>
    <form onSubmit={save} className="flex flex-col gap-4" noValidate>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex items-start gap-2">
          <TextInput className="min-w-0 flex-1" label={t('code')} value={v.code} onChange={(x) => set({ code: x.toUpperCase() })} maxLength={32} spellCheck={false} error={field(fields.code)}/>
          <Button variant="ghost" isIconOnly className="mt-6" aria-label={t('generate')} onPress={() => set({ code: randomCode() })}><I name="dices" size={16}/></Button>
        </div>
        <SelectInput label={t('kind')} value={v.kind} onChange={(x) => set({ kind: x })} options={[{ id: 'percent', label: t('percent') }, { id: 'fixed', label: t('fixed') }]}/>
        <TextInput label={v.kind === 'percent' ? t('valuePercent') : t('valueFixed')} value={v.value} onChange={(x) => set({ value: x })} maxLength={12} error={field(fields.value)}/>
        {v.kind === 'fixed' && <SelectInput label={t('currency')} value={v.currency} onChange={(x) => set({ currency: x })} error={field(fields.currency)}
          options={['TRY', 'EUR', 'USD'].map((c) => ({ id: c, label: c }))}/>}
        <TextInput label={t('periods')} value={v.periods} onChange={(x) => set({ periods: x.replace(/\D/g, '') })} maxLength={3} help={t('periodsHelp')} error={field(fields.periods)}/>
        <TextInput label={t('maxUses')} value={v.maxUses} onChange={(x) => set({ maxUses: x.replace(/\D/g, '') })} maxLength={7} help={t('maxUsesHelp')} error={field(fields.maxUses)}/>
        <TextInput label={t('expires')} type="date" value={v.expiresAt} onChange={(x) => set({ expiresAt: x })} help={t('expiresHelp')} error={field(fields.expiresAt)}/>
        <TextInput label={t('note')} value={v.note} onChange={(x) => set({ note: x })} maxLength={200} help={t('noteHelp')}/>
      </div>
      {(() => {
        const n = Number(v.value.replace(',', '.'));
        if (!(n > 0)) return null;
        const base = v.kind === 'percent' ? 100 : Math.max(100, Math.ceil(n * 2 / 50) * 50);
        const pay = Math.max(0, v.kind === 'percent' ? base * (1 - Math.min(n, 100) / 100) : base - n);
        const cur = v.kind === 'fixed' ? v.currency : 'TRY';
        return <p role="status" className="flex flex-wrap items-center gap-2 self-start rounded-xl border border-accent/40 bg-accent-soft/40 px-3 py-2 text-sm">
          <I name="calculator" size={15} className="text-accent"/>
          {t('example', { base: format.number(base, { style: 'currency', currency: cur }), pay: format.number(pay, { style: 'currency', currency: cur }),
            periods: v.periods ? Number(v.periods) : 0 })}
          {v.kind === 'percent' && n > 100 && <span className="text-danger">{t('over100')}</span>}
        </p>;
      })()}
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
        <CheckboxInput label={t('oncePerUser')} isSelected={v.oncePerUser} onChange={(x) => set({ oncePerUser: x })}/>
        <CheckboxInput label={t('newCustomers')} isSelected={v.newCustomers} onChange={(x) => set({ newCustomers: x })}/>
      </div>
      {packages.length > 0 && <CheckboxList label={t('packages')} help={t('packagesHelp')} value={v.packageIds} onChange={(x) => set({ packageIds: x })} options={packages.map((p) => ({ id: p.id, label: p.name }))}/>}
      <div><Button type="submit" isPending={busy}><I name="ticket" size={16}/>{t('create')}</Button></div>
    </form>
  </Section>;
}

export function AdminCoupons({ manage }: { manage: boolean }) {
  const t = useTranslations('Coupons');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const list = useApiQuery<{ coupons: Coupon[] }>(['admin', 'coupons'], '/admin/coupons').data?.coupons;
  const reload = () => void client.invalidateQueries({ queryKey: ['admin', 'coupons'] });
  async function toggle(c: Coupon, active: boolean) {
    try { await apiFetch(`/admin/coupons/${c.id}`, { method: 'PUT', body: { active } }); reload(); } catch (e) { toast.danger(error(e)); }
  }
  async function remove(c: Coupon) {
    try { await apiFetch(`/admin/coupons/${c.id}`, { method: 'DELETE' }); toast.success(t('deleted', { code: c.code })); reload(); } catch (e) { toast.danger(error(e)); }
  }
  const off = (c: Coupon) => c.kind === 'percent' ? `%${format.number(Number(c.value))}` : format.number(Number(c.value), { style: 'currency', currency: c.currency ?? 'TRY' });
  const expired = (c: Coupon) => !!c.expiresAt && new Date(c.expiresAt) < new Date();
  const usedUp = (c: Coupon) => c.maxUses !== null && c.uses >= c.maxUses;
  // What a customer meets when typing the code: off, expired, used up, or working.
  const state = (c: Coupon) => !c.active ? 'inactive' : expired(c) ? 'expired' : usedUp(c) ? 'usedUp' : 'active';
  const [find, setFind] = useState('');
  const [show, setShow] = useState<'all' | 'active' | 'ended'>('all');
  const needle = fold(find.trim());
  const rows = (list ?? []).filter((c) => (show === 'all' || (show === 'active') === (state(c) === 'active')) && (!needle || fold(`${c.code} ${c.note ?? ''}`).includes(needle)));
  const copy = async (code: string) => { await navigator.clipboard?.writeText(code).catch(() => undefined); toast.success(t('copied', { code })); };
  return <div className="flex flex-col gap-6">
    {manage && <NewCoupon onDone={reload}/>}
    {!!list?.length && <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
      <SearchField aria-label={t('find')} value={find} onChange={setFind} className="w-full md:w-72">
        <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('find')}/><SearchField.ClearButton/></SearchField.Group>
      </SearchField>
      <div role="group" aria-label={t('state')} className="flex flex-wrap gap-1.5">
        {(['all', 'active', 'ended'] as const).map((k) => <button key={k} type="button" aria-pressed={show === k} onClick={() => setShow(k)}
          className={`min-h-10 rounded-lg border px-3 text-sm transition-colors ${show === k ? 'border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border hover:border-accent'}`}>
          {t(`show.${k}`)} <span className="tabular-nums text-muted">{k === 'all' ? list.length : list.filter((c) => (k === 'active') === (state(c) === 'active')).length}</span></button>)}
      </div>
      {rows.length > 0 && <Button variant="ghost" className="md:ml-auto" onPress={() => downloadCsv('coupons', ['code', 'kind', 'value', 'currency', 'invoices', 'uses', 'max_uses', 'expires', 'state', 'note'],
        rows.map((c) => [c.code, c.kind, c.value, c.currency ?? '', c.periods ?? '', c.uses, c.maxUses ?? '', c.expiresAt ?? '', state(c), c.note ?? '']))}><I name="download" size={15}/>{t('export')}</Button>}
    </div>}
    <DataTable label={t('title')} rows={rows} rowKey={(c) => c.id} empty={list ? (list.length ? t('noMatch') : t('none')) : '…'} minWidth={860}
      columns={[{ id: 'code', label: t('code') }, { id: 'off', label: t('discount') }, { id: 'for', label: t('duration') }, { id: 'uses', label: t('uses') },
        { id: 'until', label: t('expires') }, { id: 'state', label: t('state') }, { id: 'x', label: '' }]}
      cells={(c) => [
        <span key="c" className="flex flex-col"><span className="flex items-center gap-1"><span className="font-mono font-medium">{c.code}</span>
          <Button size="sm" variant="ghost" isIconOnly className="size-7 min-w-7" aria-label={t('copy', { code: c.code })} onPress={() => void copy(c.code)}><I name="copy" size={13}/></Button></span>
          {c.note && <span className="text-xs text-muted">{c.note}</span>}</span>,
        <span key="o" className="flex flex-col"><span className="tabular-nums">{off(c)}</span>
          <span className="text-xs text-muted">{[c.oncePerUser && t('oncePerUserShort'), c.newCustomers && t('newCustomersShort'), c.packageIds && t('packagesShort', { n: c.packageIds.length })].filter(Boolean).join(' · ')}</span></span>,
        c.periods === null ? t('always') : t('periodsShort', { n: c.periods }),
        <span key="u" className="flex min-w-24 flex-col gap-1 tabular-nums"><span>{c.maxUses === null ? c.uses : `${c.uses} / ${c.maxUses}`}</span>
          {c.maxUses !== null && c.maxUses > 0 && <ProgressBar aria-label={t('usesOf', { code: c.code })} value={Math.min(100, (c.uses / c.maxUses) * 100)} size="sm" color={usedUp(c) ? 'danger' : c.uses / c.maxUses > 0.8 ? 'warning' : 'success'}>
            <ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>}
          {c.activeSubscriptions > 0 && <span className="text-xs text-muted">{t('subscriptions', { n: c.activeSubscriptions })}</span>}</span>,
        c.expiresAt ? format.dateTime(new Date(c.expiresAt), { dateStyle: 'medium' }) : '–',
        <span key="s" className="flex items-center gap-2">
          {manage && <SwitchInput label={<span className="sr-only">{t('activeFor', { code: c.code })}</span>} isSelected={c.active} onChange={(x) => toggle(c, x)}/>}
          {(!manage || (c.active && state(c) !== 'active')) && <StatusChip tone={state(c) === 'active' ? 'success' : state(c) === 'inactive' ? 'default' : 'warning'}>{t(state(c))}</StatusChip>}
        </span>,
        manage && c.uses === 0 ? <ConfirmButton key="x" size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={<span className="sr-only">{t('delete')}</span>} title={t('deleteTitle', { code: c.code })}
          body={t('deleteBody')} confirmLabel={t('delete')} cancelLabel={t('cancel')} onConfirm={() => remove(c)}/> : '',
      ]}/>
  </div>;
}
