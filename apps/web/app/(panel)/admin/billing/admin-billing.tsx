"use client";
// Billing for staff: monthly recurring revenue, what is open and overdue, money collected, then every invoice,
// subscription and payment, with the hand-made actions (a new invoice, a balance correction, run collection now).
import { Button, Modal, SearchField, Tabs, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import NextLink from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { I } from '../../../../components/icon';
import { DataTable, Notice, PageHeader, SelectInput, StatusChip, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import type { Invoice, Payment, Subscription } from '../../../../lib/billing';
import { invoiceState, invoiceTone, paymentTone, subscriptionTone } from '../../../../lib/billing';
import { useMe } from '../../../../lib/me';
import { can } from '../../../../lib/permissions';
import { useApiQuery } from '../../../../lib/query';

type Money = { currency: string; amount: string };
type Overview = { mrr: Money[]; open: (Money & { n: number; overdue: number })[]; collectedThisMonth: (Money & { n: number })[]; series: (Money & { month: string })[];
  subscriptions: Record<string, number>; recentPayments: Payment[] };
const tooltipStyle = { background: 'var(--overlay)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--overlay-foreground)', fontSize: 12 };
const tabs = ['invoices', 'subscriptions', 'payments'] as const;

export default function AdminBilling() {
  const t = useTranslations('BillingAdmin');
  const format = useFormatter();
  const me = useMe();
  const manage = can(me?.permissions, 'billing.manage');
  const client = useQueryClient();
  const { error } = useErrorText();
  const [tab, setTab] = useQueryState('tab', parseAsString.withDefault('invoices'));
  const [dialog, setDialog] = useState<'invoice' | 'balance' | null>(null);
  const [running, setRunning] = useState(false);
  const o = useApiQuery<Overview>(['admin', 'billing', 'overview'], '/admin/billing/overview', { refetchInterval: 60_000 }).data;
  const settings = useApiQuery<{ billing: { enabled: boolean; sandbox: boolean } }>(['admin', 'billing', 'settings'], '/admin/settings/billing').data?.billing;
  const sum = (list: Money[] | undefined) => list?.length ? list.map((m) => format.number(Number(m.amount), { style: 'currency', currency: m.currency, maximumFractionDigits: 0 })).join(' · ') : '–';
  const currencies = [...new Set(o?.series.map((s) => s.currency) ?? [])];
  const months = [...new Set(o?.series.map((s) => s.month) ?? [])];
  const chart = months.map((m) => ({ month: format.dateTime(new Date(`${m}-01T12:00:00`), { month: 'short', year: '2-digit' }),
    ...Object.fromEntries(currencies.map((c) => [c, Number(o?.series.find((s) => s.month === m && s.currency === c)?.amount ?? 0)])) }));
  const colors = ['var(--accent)', 'var(--success)', 'var(--warning)'];
  async function run() {
    setRunning(true);
    try {
      const r = await apiFetch<Record<string, number>>('/admin/billing/run', { method: 'POST' });
      toast.success(t('ran', { renewals: r.renewals ?? 0, charged: r.charged ?? 0, suspended: r.suspended ?? 0 }));
      void client.invalidateQueries({ queryKey: ['admin', 'billing'] });
    } catch (e) { toast.danger(error(e)); } finally { setRunning(false); }
  }
  const kpis = [
    { k: 'mrr', icon: <I name="trending-up" size={16}/>, value: sum(o?.mrr), tone: 'text-accent', hint: '' },
    { k: 'collected', icon: <I name="banknote" size={16}/>, value: sum(o?.collectedThisMonth), tone: 'text-success', hint: o ? t('payments', { n: o.collectedThisMonth.reduce((a, x) => a + x.n, 0) }) : '' },
    { k: 'open', icon: <I name="receipt" size={16}/>, value: sum(o?.open), tone: 'text-warning', hint: o ? t('openCount', { n: o.open.reduce((a, x) => a + x.n, 0) }) : '' },
    { k: 'overdue', icon: <I name="alarm-clock" size={16}/>, value: o ? String(o.open.reduce((a, x) => a + x.overdue, 0)) : '–', tone: 'text-danger', hint: t('overdueHint') },
  ] as const;
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')}
      actions={manage && <div className="flex flex-wrap gap-2">
        <Button variant="secondary" isPending={running} onPress={() => void run()}><I name="play" size={16}/>{t('run')}</Button>
        <Button variant="secondary" onPress={() => setDialog('balance')}><I name="wallet" size={16}/>{t('adjust')}</Button>
        <Button onPress={() => setDialog('invoice')}><I name="file-plus-2" size={16}/>{t('newInvoice')}</Button>
      </div>}/>
    {settings && !settings.enabled && <div className="mb-4"><Notice tone="warning" title={t('offTitle')}>{t('off')} <NextLink href="/admin/settings?tab=billing" className="font-medium text-accent hover:underline">{t('openSettings')}</NextLink></Notice></div>}
    {settings?.sandbox && <div className="mb-4"><Notice tone="default" title={t('sandboxTitle')}>{t('sandbox')}</Notice></div>}
    <ul className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {kpis.map((x, i) => <motion.li key={x.k} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} className="rounded-2xl border border-border bg-surface p-4">
        <p className="flex items-center gap-2 text-xs text-muted"><span className={x.tone}>{x.icon}</span>{t(`kpi.${x.k}`)}</p>
        <p className="mt-1 truncate text-2xl font-semibold tabular-nums" title={x.value}>{x.value}</p>
        {x.hint && <p className="text-xs text-muted">{x.hint}</p>}
      </motion.li>)}
    </ul>
    <div className="mb-6 grid gap-4 lg:grid-cols-3">
      <div className="rounded-2xl border border-border bg-surface p-4 lg:col-span-2">
        <h2 className="mb-3 text-sm font-semibold">{t('revenue')}</h2>
        {!chart.length ? <p className="py-10 text-center text-sm text-muted">{t('noRevenue')}</p> : <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} margin={{ left: 0, right: 8 }}>
              <CartesianGrid vertical={false} stroke="var(--separator)"/>
              <XAxis dataKey="month" tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--separator)"/>
              <YAxis tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--separator)" width={56}/>
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'color-mix(in oklab, var(--muted) 12%, transparent)' }}/>
              {currencies.map((c, i) => <Bar key={c} dataKey={c} name={c} fill={colors[i % colors.length]} radius={[4, 4, 0, 0]} maxBarSize={48}/>)}
            </BarChart>
          </ResponsiveContainer>
        </div>}
      </div>
      <div className="rounded-2xl border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('subscriptionsByStatus')}</h2>
        <ul className="flex flex-col gap-2">{(['active', 'past_due', 'suspended', 'pending', 'cancelled', 'ended'] as const).map((s) => {
          const n = o?.subscriptions[s] ?? 0;
          const total = Object.values(o?.subscriptions ?? {}).reduce((a, x) => a + x, 0) || 1;
          return <li key={s} className="text-sm">
            <div className="flex items-center justify-between"><StatusChip tone={subscriptionTone(s)}>{t(`sub.${s}`)}</StatusChip><span className="tabular-nums">{n}</span></div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-default"><motion.div className="h-full rounded-full bg-accent" initial={{ width: 0 }} animate={{ width: `${(n / total) * 100}%` }}/></div>
          </li>;
        })}</ul>
      </div>
    </div>
    <Tabs selectedKey={tabs.includes(tab as 'invoices') ? tab : 'invoices'} onSelectionChange={(k) => void setTab(String(k))}>
      <Tabs.ListContainer className="overflow-x-auto">
        <Tabs.List aria-label={t('title')}>{tabs.map((k) => <Tabs.Tab key={k} id={k} className="whitespace-nowrap">{t(`tabs.${k}`)}<Tabs.Indicator/></Tabs.Tab>)}</Tabs.List>
      </Tabs.ListContainer>
      <Tabs.Panel id="invoices" className="pt-5"><Invoices/></Tabs.Panel>
      <Tabs.Panel id="subscriptions" className="pt-5"><Subscriptions manage={manage}/></Tabs.Panel>
      <Tabs.Panel id="payments" className="pt-5"><Payments/></Tabs.Panel>
    </Tabs>
    {dialog === 'invoice' && <NewInvoice onClose={() => setDialog(null)}/>}
    {dialog === 'balance' && <AdjustBalance onClose={() => setDialog(null)}/>}
  </>;
}

function Invoices() {
  const t = useTranslations('BillingAdmin');
  const tb = useTranslations('Billing');
  const format = useFormatter();
  const [status, setStatus] = useQueryState('status', parseAsString.withDefault(''));
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const list = useApiQuery<{ invoices: Invoice[] }>(['admin', 'billing', 'invoices', status, q], `/admin/billing/invoices?status=${status}&q=${encodeURIComponent(q)}`).data?.invoices;
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-end gap-3">
      <SearchField aria-label={t('search')} value={q} onChange={(v) => void setQ(v || null)} className="min-w-64 flex-1">
        <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('search')}/><SearchField.ClearButton/></SearchField.Group>
      </SearchField>
      <SelectInput className="w-48" label={t('status')} value={status} onChange={(v) => void setStatus(v || null)}
        options={[{ id: '', label: t('all') }, ...(['unpaid', 'overdue', 'paid', 'partially_refunded', 'refunded', 'cancelled'] as const).map((s) => ({ id: s, label: tb(`status.${s}`) }))]}/>
    </div>
    <DataTable label={t('tabs.invoices')} rows={list ?? []} rowKey={(i) => i.id} empty={list ? t('noInvoices') : '…'} minWidth={860}
      columns={[{ id: 'no', label: tb('col.number') }, { id: 'who', label: t('customer') }, { id: 'kind', label: tb('col.kind') }, { id: 'date', label: tb('col.date') },
        { id: 'total', label: tb('col.total') }, { id: 'status', label: tb('col.status') }, { id: 'e', label: 'e-Fatura' }]}
      cells={(i) => [
        <NextLink key="n" href={`/admin/billing/invoices/${i.id}`} className="font-mono text-sm font-medium text-accent hover:underline">{i.number ?? `#${i.id.slice(0, 8).toUpperCase()}`}</NextLink>,
        <span key="w" className="min-w-0"><span className="block truncate">{i.buyerName}</span><span className="block truncate text-xs text-muted">{i.buyerEmail}</span></span>,
        tb(`kind.${i.kind}`),
        format.dateTime(new Date(i.issuedAt ?? i.createdAt), { dateStyle: 'medium' }),
        <span key="t" className="tabular-nums">{format.number(Number(i.total), { style: 'currency', currency: i.currency })}</span>,
        <StatusChip key="s" tone={invoiceTone(i)}>{tb(`status.${invoiceState(i)}`)}</StatusChip>,
        i.einvoiceStatus === 'none' ? <span key="e" className="text-xs text-muted">–</span> : <StatusChip key="e" tone={i.einvoiceStatus === 'failed' || i.einvoiceStatus === 'rejected' ? 'danger' : i.einvoiceStatus === 'queued' ? 'warning' : 'success'}>{tb(`einvoice.${i.einvoiceStatus as 'sent'}`)}</StatusChip>,
      ]}/>
  </div>;
}

function Subscriptions({ manage }: { manage: boolean }) {
  const t = useTranslations('BillingAdmin');
  const tb = useTranslations('Billing');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const [status, setStatus] = useState('');
  const list = useApiQuery<{ subscriptions: Subscription[] }>(['admin', 'billing', 'subscriptions', status], `/admin/billing/subscriptions?status=${status}`).data?.subscriptions;
  const [edit, setEdit] = useState<Subscription | null>(null);
  async function act(s: Subscription, action: string) {
    try { await apiFetch(`/admin/billing/subscriptions/${s.id}`, { method: 'PUT', body: { action } }); toast.success(t(`done.${action as 'suspend'}`)); void client.invalidateQueries({ queryKey: ['admin', 'billing'] }); }
    catch (e) { toast.danger(error(e)); }
  }
  return <div className="flex flex-col gap-3">
    <SelectInput className="w-48" label={t('status')} value={status} onChange={setStatus}
      options={[{ id: '', label: t('all') }, ...(['active', 'past_due', 'suspended', 'pending', 'cancelled', 'ended'] as const).map((s) => ({ id: s, label: t(`sub.${s}`) }))]}/>
    <DataTable label={t('tabs.subscriptions')} rows={list ?? []} rowKey={(s) => s.id} empty={list ? t('noSubscriptions') : '…'} minWidth={860}
      columns={[{ id: 'what', label: t('what') }, { id: 'who', label: t('customer') }, { id: 'amount', label: tb('col.amount') }, { id: 'end', label: t('periodEnd') }, { id: 'status', label: tb('col.status') }, { id: 'act', label: <span className="sr-only">{tb('col.actions')}</span> }]}
      cells={(s) => [
        <span key="w">{s.serverId ? <NextLink href={`/servers/${s.serverId}`} className="text-accent hover:underline">{s.description}</NextLink> : s.description}</span>,
        <span key="u" className="text-sm">{s.email}</span>,
        <span key="a" className="tabular-nums">{format.number(Number(s.amount), { style: 'currency', currency: s.currency })}{s.periodMonths > 1 && ` × ${s.periodMonths}`}</span>,
        <span key="e" className="text-sm">{s.periodEnd ? format.dateTime(new Date(s.periodEnd), { dateStyle: 'medium' }) : '–'}{s.cancelAtPeriodEnd && <span className="block text-xs text-warning">{t('endsThen')}</span>}</span>,
        <StatusChip key="s" tone={subscriptionTone(s.status)}>{t(`sub.${s.status}`)}</StatusChip>,
        manage && !['cancelled', 'ended'].includes(s.status) ? <span key="x" className="flex gap-1">
          <Button size="sm" variant="ghost" isIconOnly aria-label={t('edit', { name: s.description })} onPress={() => setEdit(s)}><I name="pencil" size={14}/></Button>
          {s.status === 'suspended' ? <Button size="sm" variant="ghost" onPress={() => void act(s, 'resume')}>{t('resume')}</Button>
            : <Button size="sm" variant="ghost" onPress={() => void act(s, 'suspend')}>{t('suspend')}</Button>}
        </span> : <span key="x"/>,
      ]}/>
    {edit && <EditSubscription s={edit} onClose={() => setEdit(null)}/>}
  </div>;
}

function Payments() {
  const t = useTranslations('BillingAdmin');
  const tb = useTranslations('Billing');
  const format = useFormatter();
  const [status, setStatus] = useState('');
  const list = useApiQuery<{ payments: Payment[] }>(['admin', 'billing', 'payments', status], `/admin/billing/payments?status=${status}`).data?.payments;
  return <div className="flex flex-col gap-3">
    <SelectInput className="w-48" label={t('status')} value={status} onChange={setStatus}
      options={[{ id: '', label: t('all') }, ...(['succeeded', 'failed', 'pending', 'refunded', 'partially_refunded'] as const).map((s) => ({ id: s, label: tb(`payment.${s}`) }))]}/>
    <DataTable label={t('tabs.payments')} rows={list ?? []} rowKey={(p) => p.id} empty={list ? t('noPayments') : '…'} minWidth={860}
      columns={[{ id: 'date', label: tb('col.date') }, { id: 'who', label: t('customer') }, { id: 'inv', label: tb('col.number') }, { id: 'how', label: t('method') }, { id: 'amount', label: tb('col.amount') }, { id: 'status', label: tb('col.status') }]}
      cells={(p) => [
        format.dateTime(new Date(p.createdAt), { dateStyle: 'short', timeStyle: 'short' }),
        <span key="u" className="text-sm">{p.email}</span>,
        <NextLink key="i" href={`/admin/billing/invoices/${p.invoiceId}`} className="font-mono text-sm text-accent hover:underline">{p.number ?? `#${p.invoiceId?.slice(0, 8).toUpperCase()}`}</NextLink>,
        <span key="m" className="text-sm">{tb(`method.${p.method as 'card'}`)} · {p.provider}{p.mode === 'test' && ` (${tb('testMode')})`}{p.automatic && <span className="block text-xs text-muted">{tb('automatic')}</span>}</span>,
        <span key="a" className="tabular-nums">{format.number(Number(p.amount), { style: 'currency', currency: p.currency })}</span>,
        <span key="s" className="flex flex-col items-start gap-0.5"><StatusChip tone={paymentTone(p.status)}>{tb(`payment.${p.status as 'succeeded'}`)}</StatusChip>
          {p.errorCode && <span className="text-xs text-danger">{p.errorMessage || p.errorCode}</span>}</span>,
      ]}/>
  </div>;
}

function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  return <Modal.Backdrop isOpen onOpenChange={(o) => { if (!o) onClose(); }}>
    <Modal.Container size="lg" scroll="inside"><Modal.Dialog>
      <Modal.CloseTrigger/>
      <Modal.Header><Modal.Heading>{title}</Modal.Heading></Modal.Header>
      <Modal.Body className="flex flex-col gap-4">{children}</Modal.Body>
      <Modal.Footer className="flex flex-wrap justify-end gap-2">{footer}</Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}

const fieldsOf = (e: unknown, field: (c?: string) => string | undefined) => Object.fromEntries(Object.entries((e as { fields?: Record<string, string> })?.fields ?? {}).map(([k, c]) => [k, field(c) ?? c]));

function UserPicker({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  const t = useTranslations('BillingAdmin');
  const users = useApiQuery<{ users: { id: string; email: string; name: string }[] }>(['admin', 'users'], '/admin/users').data?.users ?? [];
  return <SelectInput label={t('customer')} value={value} onChange={onChange} error={error} placeholder={t('pickCustomer')} options={users.map((u) => ({ id: u.id, label: u.name ? `${u.name} · ${u.email}` : u.email }))}/>;
}

function NewInvoice({ onClose }: { onClose: () => void }) {
  const t = useTranslations('BillingAdmin');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const [v, setV] = useState({ userId: '', currency: 'TRY', dueDays: '7', note: '' });
  const [lines, setLines] = useState([{ description: '', unitPrice: '', quantity: '1' }]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const net = lines.reduce((a, l) => a + (Number(l.unitPrice.replace(',', '.')) || 0) * (Number(l.quantity) || 0), 0);
  async function save() {
    setBusy(true); setErrors({});
    try {
      await apiFetch('/admin/billing/invoices', { method: 'POST', body: { ...v, dueDays: Number(v.dueDays), lines: lines.map((l) => ({ ...l, unitPrice: l.unitPrice.replace(',', '.'), quantity: Number(l.quantity) })) } });
      toast.success(t('invoiceCreated')); void client.invalidateQueries({ queryKey: ['admin', 'billing'] }); onClose();
    } catch (e) { const f = fieldsOf(e, field); setErrors(f); if (!Object.keys(f).length) toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Dialog title={t('newInvoice')} onClose={onClose}
    footer={<><Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button><Button isPending={busy} onPress={() => void save()}><I name="file-plus-2" size={16}/>{t('create')}</Button></>}>
    <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
      <UserPicker value={v.userId} onChange={(x) => setV({ ...v, userId: x })} error={errors.userId}/>
      <SelectInput label={t('currency')} value={v.currency} onChange={(x) => setV({ ...v, currency: x })} options={['TRY', 'EUR', 'USD'].map((c) => ({ id: c, label: c }))}/>
      <TextInput label={t('dueDays')} value={v.dueDays} onChange={(x) => setV({ ...v, dueDays: x })} error={errors.dueDays} autoComplete="off"/>
    </div>
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{t('lines')}</legend>
      {lines.map((l, i) => <div key={i} className="grid grid-cols-[1fr_6rem_5rem_auto] items-start gap-2">
        <TextInput label={t('lineDescription')} value={l.description} onChange={(x) => setLines(lines.map((y, j) => j === i ? { ...y, description: x } : y))} error={errors[`lines.${i}.description`]} autoComplete="off"/>
        <TextInput label={t('linePrice')} value={l.unitPrice} onChange={(x) => setLines(lines.map((y, j) => j === i ? { ...y, unitPrice: x } : y))} error={errors[`lines.${i}.unitPrice`]} autoComplete="off"/>
        <TextInput label={t('lineQuantity')} value={l.quantity} onChange={(x) => setLines(lines.map((y, j) => j === i ? { ...y, quantity: x } : y))} error={errors[`lines.${i}.quantity`]} autoComplete="off"/>
        <Button className="mt-6" size="sm" variant="ghost" isIconOnly aria-label={t('removeLine')} isDisabled={lines.length === 1} onPress={() => setLines(lines.filter((_, j) => j !== i))}><I name="x" size={14}/></Button>
      </div>)}
      <div className="flex items-center justify-between">
        <Button size="sm" variant="ghost" onPress={() => setLines([...lines, { description: '', unitPrice: '', quantity: '1' }])}><I name="plus" size={14}/>{t('addLine')}</Button>
        <span className="text-sm text-muted">{t('netTotal', { amount: net.toFixed(2), currency: v.currency })}</span>
      </div>
    </fieldset>
    <TextInput label={t('note')} value={v.note} onChange={(x) => setV({ ...v, note: x })} multiline autoComplete="off" help={t('noteHelp')}/>
  </Dialog>;
}

function AdjustBalance({ onClose }: { onClose: () => void }) {
  const t = useTranslations('BillingAdmin');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const [v, setV] = useState({ userId: '', amount: '', currency: 'TRY', note: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErrors({});
    try { await apiFetch('/admin/billing/balance', { method: 'POST', body: { ...v, amount: v.amount.replace(',', '.') } }); toast.success(t('adjusted')); void client.invalidateQueries({ queryKey: ['admin', 'billing'] }); onClose(); }
    catch (e) { const f = fieldsOf(e, field); setErrors(f); if (!Object.keys(f).length) toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Dialog title={t('adjust')} onClose={onClose}
    footer={<><Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button><Button isPending={busy} onPress={() => void save()}><I name="check" size={16}/>{t('save')}</Button></>}>
    <p className="text-sm text-muted">{t('adjustHelp')}</p>
    <UserPicker value={v.userId} onChange={(x) => setV({ ...v, userId: x })} error={errors.userId}/>
    <div className="grid grid-cols-[1fr_auto] gap-3">
      <TextInput label={t('amount')} value={v.amount} onChange={(x) => setV({ ...v, amount: x })} error={errors.amount} help={t('amountHelp')} autoComplete="off"/>
      <SelectInput label={t('currency')} value={v.currency} onChange={(x) => setV({ ...v, currency: x })} options={['TRY', 'EUR', 'USD'].map((c) => ({ id: c, label: c }))}/>
    </div>
    <TextInput label={t('reason')} value={v.note} onChange={(x) => setV({ ...v, note: x })} error={errors.note} isRequired autoComplete="off"/>
  </Dialog>;
}

function EditSubscription({ s, onClose }: { s: Subscription; onClose: () => void }) {
  const t = useTranslations('BillingAdmin');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const [v, setV] = useState({ amount: s.amount, periodMonths: String(s.periodMonths), periodEnd: s.periodEnd?.slice(0, 10) ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function save(action?: string) {
    setBusy(true); setErrors({});
    try {
      await apiFetch(`/admin/billing/subscriptions/${s.id}`, { method: 'PUT', body: action ? { action } : { amount: v.amount.replace(',', '.'), periodMonths: Number(v.periodMonths), periodEnd: v.periodEnd || undefined } });
      toast.success(t(action ? `done.${action as 'cancel'}` : 'saved')); void client.invalidateQueries({ queryKey: ['admin', 'billing'] }); onClose();
    } catch (e) { const f = fieldsOf(e, field); setErrors(f); if (!Object.keys(f).length) toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Dialog title={s.description} onClose={onClose}
    footer={<><Button variant="danger-soft" isDisabled={busy} onPress={() => void save('cancel')}>{t('cancelNow')}</Button><span className="flex-1"/>
      <Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button><Button isPending={busy} onPress={() => void save()}><I name="check" size={16}/>{t('save')}</Button></>}>
    <div className="grid gap-3 sm:grid-cols-3">
      <TextInput label={t('monthlyAmount', { currency: s.currency })} value={v.amount} onChange={(x) => setV({ ...v, amount: x })} error={errors.amount} autoComplete="off"/>
      <SelectInput label={t('period')} value={v.periodMonths} onChange={(x) => setV({ ...v, periodMonths: x })} options={['1', '3', '6', '12'].map((m) => ({ id: m, label: t('months', { n: Number(m) }) }))}/>
      <TextInput label={t('periodEnd')} type="date" value={v.periodEnd} onChange={(x) => setV({ ...v, periodEnd: x })} error={errors.periodEnd}/>
    </div>
    <p className="text-xs text-muted">{t('editHelp')}</p>
  </Dialog>;
}
