"use client";
// The customer's billing: balance and what is open at a glance, then invoices, subscriptions, balance movements,
// saved cards and the invoice details (TCKN / VKN) every invoice is issued to.
import { Button, Card, Modal, SearchField, Tabs, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { useEffect, useState } from 'react';
import { I } from '../../../components/icon';
import { ButtonLink, ConfirmButton, DataTable, Empty, FormActions, FormSection, Notice, PageHeader, SelectInput, StatusChip, SwitchInput, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { downloadCsv, localDay } from '../../../lib/csv';
import type { Card as SavedCard, Invoice, Subscription, Summary } from '../../../lib/billing';
import { MyDisputes } from './disputes';
import { invoiceState, invoiceTone, subscriptionTone, type Hourly } from '../../../lib/billing';
import { useApiQuery } from '../../../lib/query';
import { fold } from '../../../lib/note-line';
import { useMe } from '../../../lib/me';
import { can } from '../../../lib/permissions';

const tabs = ['invoices', 'subscriptions', 'balance', 'cards', 'disputes', 'profile'] as const;

export default function Billing() {
  const t = useTranslations('Billing');
  const format = useFormatter();
  const [tab, setTab] = useQueryState('tab', parseAsString.withDefault('invoices'));
  const [topup, setTopup] = useState(false);
  const [show, setShow] = useQueryState('show', parseAsString.withDefault('all'));
  const s = useApiQuery<Summary>(['notifications', 'billing-summary'], '/billing/summary').data;
  const me = useMe();
  if (!s) return <div className="h-48 animate-pulse rounded-3xl bg-default/50"/>;
  // Staff who can turn it on get the way there.
  if (!s.enabled) return <><PageHeader title={t('title')}/><Empty icon={<I name="receipt" size={28}/>} title={t('off')}>
    {can(me?.permissions, 'settings.manage') && <><span className="block">{t('offStaff')}</span>
      <ButtonLink href="/admin/settings?tab=billing" variant="secondary" className="mt-3"><I name="settings" size={16}/>{t('turnOn')}</ButtonLink></>}</Empty></>;
  const money = (v: string, c: string) => format.number(Number(v), { style: 'currency', currency: c });
  const next = s.subscriptions.filter((x) => x.periodEnd && !x.cancelAtPeriodEnd)[0];
  return <>
    <PageHeader title={t('title')} description={t('intro')}
      actions={s.methods.balance && <Button onPress={() => setTopup(true)}><I name="wallet" size={16}/>{t('topup.open')}</Button>}/>
    {!s.profileComplete && <div className="mb-4"><Notice tone="warning" title={t('profileMissing')}>
      {t('profileMissingHelp')} <button type="button" className="font-medium text-accent hover:underline" onClick={() => void setTab('profile')}>{t('profileFill')}</button></Notice></div>}
    <ul className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <motion.li initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-surface p-4">
        <p className="flex items-center gap-2 text-xs text-muted"><I name="wallet" size={14}/>{t('kpi.balance')}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{s.balance.length ? s.balance.map((b) => money(b.amount, b.currency)).join(' · ') : money('0', 'TRY')}</p>
        {s.methods.balance && <button type="button" onClick={() => setTopup(true)} className="mt-1 text-xs font-medium text-accent hover:underline">{t('topup.open')}</button>}
      </motion.li>
      <motion.li initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
        className={`rounded-2xl border p-4 ${s.open.overdue ? 'border-danger/40 bg-danger/5' : s.open.n ? 'border-warning/40 bg-warning/5' : 'border-border bg-surface'}`}>
        <p className="flex items-center gap-2 text-xs text-muted"><I name="receipt" size={14}/>{t('kpi.open')}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{s.open.n ? money(s.open.amount, s.open.currency ?? 'TRY') : t('kpi.nothingOpen')}</p>
        <p className="text-xs text-muted">{s.open.n ? t('kpi.openCount', { n: s.open.n, overdue: s.open.overdue }) : t('kpi.allPaid')}</p>
        {s.open.n > 0 && <button type="button" onClick={() => { void setTab(null); void setShow('open'); document.getElementById('billing-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
          className="mt-1 text-xs font-medium text-accent hover:underline">{t('kpi.showOpen')}</button>}
      </motion.li>
      <motion.li initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="rounded-2xl border border-border bg-surface p-4">
        <p className="flex items-center gap-2 text-xs text-muted"><I name="calendar-clock" size={14}/>{t('kpi.next')}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{next ? money(String(Number(next.amount) * next.periodMonths), next.currency) : '–'}</p>
        <p className="text-xs text-muted">{next?.periodEnd ? t('kpi.nextOn', { date: format.dateTime(new Date(next.periodEnd), { dateStyle: 'medium' }), name: next.description }) : t('kpi.noSubscriptions')}</p>
        <p className="mt-1 flex items-center gap-1 text-xs text-muted"><I name={s.autoCharge ? 'repeat' : 'hand'} size={12}/>{s.autoCharge ? t('kpi.autoCharge') : t('kpi.manualCharge')}</p>
      </motion.li>
    </ul>
    <Tabs id="billing-tabs" className="scroll-mt-28" selectedKey={tabs.includes(tab as 'invoices') ? tab : 'invoices'} onSelectionChange={(k) => void setTab(String(k))}>
      <Tabs.ListContainer className="overflow-x-auto">
        <Tabs.List aria-label={t('title')}>{tabs.map((k) => { const n = ({ invoices: s.open.n, subscriptions: s.subscriptions.length, cards: s.cards.length } as Record<string, number>)[k];
          return <Tabs.Tab key={k} id={k} className="whitespace-nowrap">{t(`tabs.${k}`)}{!!n && <span className={`ml-1.5 rounded-full px-1.5 text-xs tabular-nums ${k === 'invoices' ? 'bg-warning/15 text-warning' : 'bg-default text-muted'}`}>{n}</span>}<Tabs.Indicator/></Tabs.Tab>; })}</Tabs.List>
      </Tabs.ListContainer>
      <Tabs.Panel id="invoices" className="pt-5"><Invoices filter={show} setFilter={(k) => void setShow(k === 'all' ? null : k)}/></Tabs.Panel>
      <Tabs.Panel id="subscriptions" className="pt-5"><Subscriptions list={s.subscriptions}/></Tabs.Panel>
      <Tabs.Panel id="balance" className="flex flex-col gap-5 pt-5">{s.hourly?.servers.length ? <HourlyUsage h={s.hourly}/> : null}<Balance/></Tabs.Panel>
      <Tabs.Panel id="cards" className="pt-5"><Cards cards={s.cards}/></Tabs.Panel>
      <Tabs.Panel id="disputes" className="pt-5"><MyDisputes/></Tabs.Panel>
      <Tabs.Panel id="profile" className="pt-5"><Profile/></Tabs.Panel>
    </Tabs>
    {topup && <Topup min={s.methods.topup.min} max={s.methods.topup.max} currency={s.balance[0]?.currency ?? s.subscriptions[0]?.currency ?? 'TRY'} onClose={() => setTopup(false)}/>}
  </>;
}

function Invoices({ filter, setFilter }: { filter: string; setFilter: (k: string) => void }) {
  const t = useTranslations('Billing');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const [q, setQ] = useQueryState('q', parseAsString.withDefault('').withOptions({ history: 'replace', throttleMs: 300 }));
  const list = useApiQuery<{ invoices: Invoice[] }>(['billing', 'invoices'], '/billing/invoices').data?.invoices;
  const needle = fold(q.trim().replace(/^#/, ''));
  const of = (k: string) => (list ?? []).filter((i) => (k === 'all' || (k === 'open' ? i.status === 'unpaid' : i.status !== 'unpaid'))
    && (!needle || [i.number ?? '', i.id, i.total, t(`kind.${i.kind}`)].some((v) => fold(v).includes(needle))));
  const rows = of(filter);
  const overdue = (list ?? []).filter((i) => i.status === 'unpaid' && i.overdue).length;
  const csv = () => downloadCsv('invoices', [t('col.number'), t('col.kind'), t('col.date'), t('csv.due'), t('col.total'), t('csv.currency'), t('col.status')],
    rows.map((i) => [i.number ?? i.id, t(`kind.${i.kind}`), localDay(i.issuedAt ?? i.createdAt), localDay(i.dueAt), i.total, i.currency, t(`status.${invoiceState(i)}`)]));
  return <div className="flex flex-col gap-4">
    {list && <SpendChart invoices={list}/>}
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('filter')}>
        {(['all', 'open', 'done'] as const).map((k) => <Button key={k} size="sm" variant={filter === k ? 'primary' : 'ghost'} aria-pressed={filter === k} onPress={() => setFilter(k)}>
          {t(`filters.${k}`)}{list && <span className="tabular-nums opacity-70">{of(k).length}</span>}</Button>)}
      </div>
      {overdue > 0 && <StatusChip tone="danger">{t('overdueCount', { n: overdue })}</StatusChip>}
      {(list?.length ?? 0) > 5 && <SearchField aria-label={t('findInvoice')} value={q} onChange={setQ} className="w-full sm:w-56">
        <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('findInvoice')}/><SearchField.ClearButton/></SearchField.Group>
      </SearchField>}
      <Button size="sm" variant="secondary" className="ml-auto" isDisabled={!rows.length} onPress={csv}><I name="download" size={14}/>{t('csv.export')}</Button>
    </div>
    <DataTable label={t('tabs.invoices')} rows={rows} rowKey={(i) => i.id} empty={list ? t('noInvoices') : '…'} minWidth={720}
      columns={[{ id: 'no', label: t('col.number') }, { id: 'kind', label: t('col.kind') }, { id: 'date', label: t('col.date') }, { id: 'total', label: t('col.total') }, { id: 'status', label: t('col.status') }, { id: 'act', label: <span className="sr-only">{t('col.actions')}</span> }]}
      cells={(i) => [
        <NextLink key="n" href={`/billing/invoices/${i.id}`} className="font-mono text-sm font-medium text-accent hover:underline">{i.number ?? `#${i.id.slice(0, 8).toUpperCase()}`}</NextLink>,
        t(`kind.${i.kind}`),
        <span key="d" className="text-sm">{format.dateTime(new Date(i.issuedAt ?? i.createdAt), { dateStyle: 'medium' })}
          {i.status === 'unpaid' && <span className={`block text-xs ${i.overdue ? 'text-danger' : 'text-muted'}`}>{t('dueIn', { when: format.relativeTime(new Date(i.dueAt), now) })}</span>}</span>,
        <span key="t" className="tabular-nums">{format.number(Number(i.total), { style: 'currency', currency: i.currency })}</span>,
        <StatusChip key="s" tone={invoiceTone(i)}>{t(`status.${invoiceState(i)}`)}</StatusChip>,
        i.status === 'unpaid' ? <NextLink key="a" href={`/billing/invoices/${i.id}`} className="inline-flex min-h-9 items-center gap-1 rounded-full bg-accent px-3 text-sm font-medium text-accent-foreground"><I name="credit-card" size={14}/>{t('pay')}</NextLink>
          : <NextLink key="a" href={`/billing/invoices/${i.id}`} className="text-sm text-accent hover:underline">{t('view')}</NextLink>,
      ]}/>
  </div>;
}

// Money paid in the last 12 months, one bar per month, in the currency most invoices use (top-ups and credit
// notes left out: a top-up is spent through later invoices).
function SpendChart({ invoices }: { invoices: Invoice[] }) {
  const t = useTranslations('Billing.spend');
  const format = useFormatter();
  const paid = invoices.filter((i) => i.paidAt && i.kind !== 'topup' && i.kind !== 'credit_note' && Number(i.paidTotal) > 0);
  if (!paid.length) return null;
  const tally = paid.reduce<Record<string, number>>((a, i) => ({ ...a, [i.currency]: (a[i.currency] ?? 0) + 1 }), {});
  const currency = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, k) => new Date(now.getFullYear(), now.getMonth() - 11 + k, 1));
  const sums = months.map((m) => paid.filter((i) => i.currency === currency && new Date(i.paidAt!).getFullYear() === m.getFullYear() && new Date(i.paidAt!).getMonth() === m.getMonth())
    .reduce((n, i) => n + Number(i.paidTotal) - Number(i.refundedTotal || 0), 0));
  const max = Math.max(...sums, 1);
  const money = (v: number) => format.number(v, { style: 'currency', currency });
  const year = sums.reduce((n, v, k) => n + (months[k].getFullYear() === now.getFullYear() ? v : 0), 0);
  return <section aria-labelledby="spend-title" className="rounded-2xl border border-border bg-surface p-4">
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 id="spend-title" className="flex items-center gap-2 text-sm font-semibold"><I name="chart-column" size={16} className="text-accent"/>{t('title')}</h3>
      <p className="text-xs text-muted">{t('totals', { year: money(year), all: money(sums.reduce((a, b) => a + b, 0)) })}</p>
    </div>
    <ol className="flex h-32 items-end gap-1 sm:gap-2" aria-label={t('title')}>
      {months.map((m, k) => { const label = format.dateTime(m, { month: 'short' }); const current = k === 11;
        return <li key={k} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${format.dateTime(m, { month: 'long', year: 'numeric' })}: ${money(sums[k])}`}>
          <span className="sr-only">{format.dateTime(m, { month: 'long', year: 'numeric' })}: {money(sums[k])}</span>
          <span aria-hidden className="hidden text-[10px] tabular-nums text-muted group-hover:block">{sums[k] ? format.number(sums[k], { notation: 'compact' }) : ''}</span>
          <span aria-hidden className={`w-full max-w-10 rounded-t-md transition-colors ${sums[k] ? (current ? 'bg-accent' : 'bg-accent/40 group-hover:bg-accent/70') : 'bg-default'}`}
            style={{ height: sums[k] ? `${Math.max(6, (sums[k] / max) * 100)}%` : '3px' }}/>
          <span aria-hidden className={`truncate text-[10px] ${current ? 'font-semibold text-foreground' : 'text-muted'}`}>{label}</span>
        </li>; })}
    </ol>
  </section>;
}

function Subscriptions({ list }: { list: Subscription[] }) {
  const t = useTranslations('Billing');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const [saving, setSaving] = useState<string>();
  async function change(s: Subscription, body: Record<string, boolean>, done: string) {
    if (saving) return;
    setSaving(s.id);
    try { await apiFetch(`/billing/subscriptions/${s.id}`, { method: 'PUT', body }); toast.success(done); await client.invalidateQueries({ queryKey: ['notifications', 'billing-summary'] }); }
    catch (e) { toast.danger(error(e)); } finally { setSaving(undefined); }
  }
  if (!list.length) return <Empty icon={<I name="repeat" size={28}/>} title={t('noSubscriptions')}/>;
  // What renews each month, per currency (subscriptions that end at their period's end left out).
  const monthly = Object.entries(list.filter((s) => !s.cancelAtPeriodEnd && s.status !== 'cancelled').reduce<Record<string, number>>((a, s) => ({ ...a, [s.currency]: (a[s.currency] ?? 0) + Number(s.amount) }), {}));
  return <div className="flex flex-col gap-3">
    {monthly.length > 0 && <p className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface px-4 py-3 text-sm">
      <I name="repeat" size={15} className="text-accent"/>{t('monthlyTotal')}
      <span className="font-semibold tabular-nums">{monthly.map(([c, v]) => format.number(v, { style: 'currency', currency: c })).join(' · ')}</span></p>}
    <ul className="flex flex-col gap-3">{list.map((s) => <li key={s.id} className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 sm:flex-row sm:items-center">
    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-default text-muted">{s.kind === 'server' ? <I name="server" size={18}/> : <I name="building-2" size={18}/>}</span>
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{s.description}</span><StatusChip tone={subscriptionTone(s.status)}>{t(`sub.${s.status}`)}</StatusChip>
        {s.cancelAtPeriodEnd && <StatusChip tone="warning">{t('sub.ending')}</StatusChip>}</span>
      <span className="block text-sm text-muted">{format.number(Number(s.amount), { style: 'currency', currency: s.currency })} / {t('perMonth')}
        {s.periodEnd && ` · ${s.cancelAtPeriodEnd ? t('endsOn', { date: format.dateTime(new Date(s.periodEnd), { dateStyle: 'medium' }) }) : t('renewsOn', { date: format.dateTime(new Date(s.periodEnd), { dateStyle: 'medium' }) })}`}</span>
    </span>
    <span className="flex flex-wrap items-center gap-3">
      <SwitchInput label={<span className="text-sm">{t('autoRenew')}</span>} isSelected={s.autoRenew && !s.cancelAtPeriodEnd} isDisabled={s.cancelAtPeriodEnd || saving === s.id}
        onChange={(v) => void change(s, { autoRenew: v }, v ? t('autoRenewOn') : t('autoRenewOff'))}/>
      {s.cancelAtPeriodEnd
        ? <Button size="sm" variant="secondary" isPending={saving === s.id} onPress={() => void change(s, { cancelAtPeriodEnd: false }, t('kept'))}><I name="rotate-ccw" size={14}/>{t('keep')}</Button>
        : <ConfirmButton size="sm" variant="danger-soft" icon={<I name="calendar-x" size={14}/>} label={t('cancelAtEnd')} title={t('cancelTitle')}
            body={t('cancelBody', { name: s.description, date: s.periodEnd ? format.dateTime(new Date(s.periodEnd), { dateStyle: 'long' }) : '–' })}
            confirmLabel={t('cancelConfirm')} cancelLabel={t('cancelKeep')} onConfirm={() => change(s, { cancelAtPeriodEnd: true }, t('cancelled'))}/>}
    </span>
  </li>)}</ul></div>;
}

// Pay as you go: what is left, how long it lasts, and each hourly server's hours and cost this month.
function HourlyUsage({ h }: { h: Hourly }) {
  const t = useTranslations('Billing.hourly');
  const format = useFormatter();
  const money = (v: string | number, c: string, digits = 2) => format.number(Number(v), { style: 'currency', currency: c, maximumFractionDigits: digits });
  return <section className="flex flex-col gap-3 rounded-2xl border border-border p-4" aria-label={t('title')}>
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold">{t('title')}</h3><p className="text-xs text-muted">{t('help')}</p></div>
    <div className="grid gap-3 sm:grid-cols-3">{h.available.map((a) => { const hours = Number(a.perHour) > 0 ? Math.floor(Number(a.amount) / Number(a.perHour)) : null;
      return <div key={a.currency} className={`rounded-xl p-3 ${Number(a.amount) < 0 ? 'bg-danger/10' : hours !== null && hours < 24 ? 'bg-warning/10' : 'bg-default/60'}`}>
        <p className="text-xs uppercase tracking-wider text-muted">{t('left')}</p>
        <p className="text-xl font-semibold tabular-nums">{money(a.amount, a.currency)}</p>
        <p className="text-xs text-muted">{t('burn', { price: money(a.perHour, a.currency, 4) })}{hours !== null && hours >= 0 ? ` · ${t('lasts', { days: Math.floor(hours / 24), hours: hours % 24 })}` : ''}</p></div>; })}</div>
    <DataTable label={t('title')} rows={h.servers} rowKey={(x) => x.id} minWidth={480}
      columns={[{ id: 'name', label: t('server') }, { id: 'price', label: t('price') }, { id: 'hours', label: t('hours') }, { id: 'amount', label: t('month') }]}
      cells={(x) => [<span key="n" className="flex items-center gap-2"><NextLink href={`/servers/${x.id}`} className="font-medium text-accent hover:underline">{x.name}</NextLink>
          {x.billingHold && <StatusChip tone="danger">{t('held')}</StatusChip>}</span>,
        money(x.priceHourly, x.currency, 4), x.hours, <span key="a" className="font-medium tabular-nums">{money(x.amount, x.currency)}</span>]}/>
  </section>;
}

function Balance() {
  const t = useTranslations('Billing');
  const format = useFormatter();
  const q = useApiQuery<{ entries: { id: string; amount: string; currency: string; reason: string; note: string | null; invoiceId: string | null; createdAt: string }[] }>(['billing', 'balance'], '/billing/balance').data;
  return <div className="flex flex-col gap-3">
    {!!q?.entries.length && <Button size="sm" variant="secondary" className="self-end" onPress={() => downloadCsv('balance', [t('col.date'), t('col.what'), t('col.amount'), t('csv.currency')],
      q.entries.map((e) => [e.createdAt, [t(`reason.${e.reason as 'topup'}`), e.note].filter(Boolean).join(' – '), e.amount, e.currency]))}>
      <I name="download" size={14}/>{t('balanceCsv')}</Button>}
    <DataTable label={t('tabs.balance')} rows={q?.entries ?? []} rowKey={(e) => e.id} empty={q ? t('noMovements') : '…'}
    columns={[{ id: 'date', label: t('col.date') }, { id: 'what', label: t('col.what') }, { id: 'amount', label: t('col.amount') }]}
    cells={(e) => [format.dateTime(new Date(e.createdAt), { dateStyle: 'medium', timeStyle: 'short' }),
      <span key="w">{t(`reason.${e.reason as 'topup'}`)}{e.note && <span className="block text-xs text-muted">{e.note}</span>}
        {e.invoiceId && <NextLink href={`/billing/invoices/${e.invoiceId}`} className="block text-xs text-accent hover:underline">{t('view')}</NextLink>}</span>,
      <span key="a" className={`tabular-nums font-medium ${Number(e.amount) > 0 ? 'text-success' : ''}`}>{Number(e.amount) > 0 && '+'}{format.number(Number(e.amount), { style: 'currency', currency: e.currency })}</span>]}/>
  </div>;
}

function Cards({ cards }: { cards: SavedCard[] }) {
  const t = useTranslations('Billing');
  const { error } = useErrorText();
  const client = useQueryClient();
  const reload = () => client.invalidateQueries({ queryKey: ['notifications', 'billing-summary'] });
  const [acting, setActing] = useState<string>();
  async function act(path: string, method: string, done: string) {
    if (acting) return;
    setActing(path);
    try { await apiFetch(path, { method }); toast.success(done); await reload(); } catch (e) { toast.danger(error(e)); } finally { setActing(undefined); }
  }
  // Months left on a card: under 0 it has expired, under 2 it is about to.
  const now = new Date();
  const left = (c: SavedCard) => c.expMonth && c.expYear ? (c.expYear - now.getFullYear()) * 12 + c.expMonth - (now.getMonth() + 1) : null;
  return <div className="flex flex-col gap-3">
    <p className="text-sm text-muted">{t('cardsHelp')}</p>
    {!cards.length ? <Empty icon={<I name="credit-card" size={28}/>} title={t('noCards')}/> : <ul className="grid gap-3 sm:grid-cols-2">{cards.map((c) =>
      <li key={c.id} className={`flex items-center gap-3 rounded-2xl border p-4 ${c.isDefault ? 'border-accent/50 bg-accent/5' : 'border-border bg-surface'}`}>
        <span className="grid h-10 w-14 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-default to-default/40 text-xs font-bold">{c.brand ?? '••'}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-mono font-medium">•••• {c.last4 ?? '????'}</span>
          <span className="block text-xs text-muted">{c.expMonth && c.expYear ? `${String(c.expMonth).padStart(2, '0')}/${c.expYear}` : ''} · {c.providerName ?? c.provider}{c.mode === 'test' && ` · ${t('testMode')}`}</span>
          {(() => { const m = left(c); return m === null || m > 1 ? null : <span className={`mt-1 inline-flex items-center gap-1 text-xs ${m < 0 ? 'text-danger' : 'text-warning'}`}>
            <I name="triangle-alert" size={12}/>{m < 0 ? t('cardExpired') : t('cardExpiring')}</span>; })()}
        </span>
        {c.isDefault ? <StatusChip tone="accent">{t('defaultCard')}</StatusChip>
          : <Button size="sm" variant="ghost" isPending={acting === `/billing/cards/${c.id}/default`} onPress={() => void act(`/billing/cards/${c.id}/default`, 'PUT', t('defaultSet'))}>{t('makeDefault')}</Button>}
        <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={<span className="sr-only">{t('removeCard', { last4: c.last4 ?? '' })}</span>}
          title={t('removeCard', { last4: c.last4 ?? '' })} body={c.isDefault ? t('removeDefaultBody') : t('removeCardBody')} confirmLabel={t('removeConfirm')} cancelLabel={t('cancelKeep')}
          onConfirm={() => act(`/billing/cards/${c.id}`, 'DELETE', t('cardRemoved'))}/>
      </li>)}</ul>}
  </div>;
}

type Profile = { kind: 'individual' | 'company'; name: string; taxId: string; taxOffice: string; country: string; city: string; district: string; address: string; postalCode: string; email: string; phone: string; einvoiceRegistered?: boolean | null };
const empty: Profile = { kind: 'individual', name: '', taxId: '', taxOffice: '', country: 'TR', city: '', district: '', address: '', postalCode: '', email: '', phone: '' };

function Profile() {
  const t = useTranslations('Billing.profile');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ profile: Profile | null }>(['billing', 'profile'], '/billing/profile').data;
  const [v, setV] = useState<Profile | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q && !v) setV({ ...empty, ...Object.fromEntries(Object.entries(q.profile ?? {}).map(([k, x]) => [k, x ?? ''])) } as Profile); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return <div className="h-40 animate-pulse rounded-3xl bg-default/50"/>;
  const set = (k: keyof Profile) => (x: string) => setV({ ...v, [k]: x });
  const tr = v.country === 'TR';
  async function save() {
    setBusy(true); setErrors({});
    try { await apiFetch('/billing/profile', { method: 'PUT', body: v }); toast.success(t('saved')); void client.invalidateQueries({ queryKey: ['notifications', 'billing-summary'] }); }
    catch (e) { const f = (e as { fields?: Record<string, string> }).fields ?? {}; setErrors(Object.fromEntries(Object.entries(f).map(([k, c]) => [k, field(c) ?? c]))); if (!Object.keys(f).length) toast.danger(error(e)); }
    finally { setBusy(false); }
  }
  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('who')} description={t('whoHelp')} icon={<I name="id-card" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectInput label={t('kind')} value={v.kind} onChange={(x) => setV({ ...v, kind: x as Profile['kind'] })} options={[{ id: 'individual', label: t('individual') }, { id: 'company', label: t('company') }]}/>
        <TextInput label={t('country')} value={v.country} onChange={(x) => setV({ ...v, country: x.toUpperCase().slice(0, 2) })} error={errors.country} help={t('countryHelp')} autoComplete="off"/>
        <TextInput label={v.kind === 'company' ? t('companyName') : t('fullName')} value={v.name} onChange={set('name')} error={errors.name} isRequired autoComplete="off"/>
        <TextInput label={tr ? (v.kind === 'company' ? 'VKN' : 'TCKN') : t('foreignTaxId')} value={v.taxId} onChange={set('taxId')} error={errors.taxId} isRequired autoComplete="off"
          help={tr ? (v.kind === 'company' ? t('vknHelp') : t('tcknHelp')) : undefined}/>
        {v.kind === 'company' && <TextInput label={t('taxOffice')} value={v.taxOffice} onChange={set('taxOffice')} error={errors.taxOffice} isRequired={tr} autoComplete="off"/>}
      </div>
      {v.einvoiceRegistered && <Notice tone="success">{t('einvoiceUser')}</Notice>}
    </FormSection>
    <FormSection title={t('address')} description={t('addressHelp')} icon={<I name="map-pin" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput label={t('city')} value={v.city} onChange={set('city')} error={errors.city} isRequired={tr} autoComplete="off"/>
        <TextInput label={t('district')} value={v.district} onChange={set('district')} error={errors.district} isRequired={tr} autoComplete="off"/>
        <div className="sm:col-span-2"><TextInput label={t('street')} value={v.address} onChange={set('address')} error={errors.address} isRequired multiline autoComplete="off"/></div>
        <TextInput label={t('postalCode')} value={v.postalCode} onChange={set('postalCode')} autoComplete="off"/>
        <TextInput label={t('phone')} value={v.phone} onChange={set('phone')} autoComplete="off"/>
        <div className="sm:col-span-2"><TextInput label={t('email')} value={v.email} onChange={set('email')} error={errors.email} help={t('emailHelp')} autoComplete="off"/></div>
      </div>
    </FormSection>
    <FormActions status={<span className="text-xs text-muted">{t('appliesTo')}</span>}><Button isPending={busy} onPress={() => void save()}><I name="check" size={16}/>{t('save')}</Button></FormActions>
  </Card.Content></Card>;
}

// Top-up: creates the top-up invoice and goes to it to pay.
function Topup({ min, max, currency, onClose }: { min: number; max: number; currency: string; onClose: () => void }) {
  const t = useTranslations('Billing.topup');
  const router = useRouter();
  const { error, field } = useErrorText();
  const [amount, setAmount] = useState(String(Math.max(min, 100)));
  const [cur, setCur] = useState(currency);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true); setErr(undefined);
    try { const r = await apiFetch<{ invoiceId: string }>('/billing/topup', { method: 'POST', body: { amount, currency: cur } }); router.push(`/billing/invoices/${r.invoiceId}`); }
    catch (e) { const f = (e as { fields?: Record<string, string> }).fields; if (f?.amount) setErr(field(f.amount)); else toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Modal.Backdrop isOpen onOpenChange={(o) => { if (!o) onClose(); }}>
    <Modal.Container><Modal.Dialog>
      <Modal.CloseTrigger/>
      <Modal.Header><Modal.Heading>{t('title')}</Modal.Heading></Modal.Header>
      <Modal.Body className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('help')}</p>
        <div className="flex flex-wrap gap-2">{[100, 250, 500, 1000].filter((x) => x >= min && x <= max).map((x) => <Button key={x} size="sm" variant={amount === String(x) ? 'primary' : 'secondary'} onPress={() => setAmount(String(x))}>{x}</Button>)}</div>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <TextInput label={t('amount')} value={amount} onChange={setAmount} error={err} help={t('range', { min, max })} autoComplete="off"/>
          <SelectInput label={t('currency')} value={cur} onChange={setCur} options={['TRY', 'EUR', 'USD'].map((c) => ({ id: c, label: c }))}/>
        </div>
      </Modal.Body>
      <Modal.Footer><Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button><Button isPending={busy} onPress={() => void go()}><I name="arrow-right" size={16}/>{t('continue')}</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}
