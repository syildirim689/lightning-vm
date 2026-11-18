"use client";
// "Upcoming charges" on the customer's first page: the next renewal, invoices that are overdue or due this week
// (each with its pay link) and, for servers paid by the hour, when the balance runs out at the current rate.
// Everything comes from what the API already answers (the billing summary and the invoice list); with nothing
// upcoming the block is not rendered at all.
import NextLink from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import type { Invoice, Summary } from '../lib/billing';
import { useApiQuery } from '../lib/query';
import { dueInvoices, renewalLine, runOut } from '../lib/upcoming';
import { I } from './icon';

const SHOWN = 3;
const action = 'inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

function Row({ icon, tone = 'default', title, detail, amount, note, children }: { icon: React.ReactNode; tone?: 'default' | 'warning' | 'danger'; title: React.ReactNode; detail?: React.ReactNode; amount?: string; note?: string; children?: React.ReactNode }) {
  const mark = { default: 'bg-default text-muted', warning: 'bg-warning/15 text-warning', danger: 'bg-danger/15 text-danger' }[tone];
  return <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 first:pt-0 last:pb-0">
    <span aria-hidden className={`grid size-8 shrink-0 place-items-center rounded-xl ${mark}`}>{icon}</span>
    <div className="min-w-0 flex-1 basis-40">
      <p className={`text-sm font-medium [overflow-wrap:anywhere] ${tone === 'danger' ? 'text-danger' : ''}`}>{title}</p>
      {detail && <p className="text-xs text-muted [overflow-wrap:anywhere]">{detail}</p>}
    </div>
    {amount && <span className="flex shrink-0 flex-col items-end"><span className="text-sm font-semibold tabular-nums">{amount}</span>
      {note && <span className="text-[11px] leading-4 text-muted">{note}</span>}</span>}
    {children}
  </li>;
}

export default function UpcomingCharges() {
  const t = useTranslations('Upcoming');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const s = useApiQuery<Summary>(['notifications', 'billing-summary'], '/billing/summary').data;
  const on = !!s?.enabled;
  // The invoice list is asked for only when the summary says something is open.
  const open = s?.enabled ? s.open.n : 0;
  const list = useApiQuery<{ invoices: Invoice[] }>(['billing', 'invoices'], on && open > 0 ? '/billing/invoices' : null);
  if (!s?.enabled) return null;

  const money = (v: number, currency: string, digits = 2) => format.number(v, { style: 'currency', currency, maximumFractionDigits: digits });
  const day = (at: string | number) => format.dateTime(new Date(at), { dateStyle: 'medium' });
  // The API's own figure when it gives one (tax included, and nothing once the renewal has its invoice: that
  // invoice is in the list above); the calculation from the subscriptions on an older API.
  const renewal = renewalLine(s.nextRenewal, s.subscriptions, now.getTime());
  const due = list.data ? dueInvoices(list.data.invoices, now.getTime()) : [];
  const spending = runOut(s.hourly, now.getTime());
  // Open invoices whose list has not arrived (or could not be read): one line from the summary's own count.
  const waiting = open > 0 && !list.data;
  if (!renewal && !due.length && !spending.length && !waiting) return null;
  const number = (i: { id: string; number: string | null }) => i.number ?? `#${i.id.slice(0, 8).toUpperCase()}`;

  return <section aria-labelledby="upcoming-title" className="rounded-2xl border border-border bg-surface p-4">
    <h2 id="upcoming-title" className="mb-3 flex items-center gap-2 text-sm font-semibold"><I name="calendar-clock" size={16} className="text-accent"/>{t('title')}</h2>
    <ul className="flex flex-col divide-y divide-separator">
      {due.slice(0, SHOWN).map((i) => <Row key={i.id} icon={<I name="receipt-text" size={15}/>} tone={i.overdue ? 'danger' : 'warning'} amount={money(i.amount, i.currency)}
        title={t(i.overdue ? 'invoiceOverdue' : 'invoiceDue', { number: number(i), when: format.relativeTime(new Date(i.dueAt), now) })} detail={day(i.dueAt)}>
        <NextLink href={`/billing/invoices/${i.id}`} aria-label={t('payLabel', { number: number(i) })} className={`${action} bg-accent text-accent-foreground`}><I name="credit-card" size={14}/>{t('pay')}</NextLink>
      </Row>)}
      {due.length > SHOWN && <Row icon={<I name="receipt" size={15}/>} title={t('moreInvoices', { n: due.length - SHOWN })}>
        <NextLink href="/billing?show=open" className={`${action} text-accent hover:underline`}>{t('showInvoices')}</NextLink>
      </Row>}
      {waiting && (list.isError
        ? <Row icon={<I name="receipt-text" size={15}/>} tone={s.open.overdue ? 'danger' : 'warning'} title={t('openFallback', { n: open })} amount={s.open.currency ? money(Number(s.open.amount), s.open.currency) : undefined}>
            <NextLink href="/billing?show=open" className={`${action} text-accent hover:underline`}>{t('showInvoices')}</NextLink>
          </Row>
        : <li role="status" aria-busy className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <span aria-hidden className="size-8 shrink-0 animate-pulse rounded-xl bg-default motion-reduce:animate-none"/>
            <span aria-hidden className="h-4 w-40 max-w-full animate-pulse rounded bg-default motion-reduce:animate-none"/>
            <span className="sr-only">{t('loadingInvoices')}</span>
          </li>)}
      {renewal && <Row icon={<I name="repeat" size={15}/>} amount={money(renewal.amount, renewal.currency)} note={renewal.gross ? t('gross') : undefined}
        title={t('renewal', { date: day(renewal.at), when: format.relativeTime(new Date(renewal.at), now) })}
        detail={<>{renewal.items.slice(0, 2).map((x, k) => <span key={x.id}>{k > 0 && ', '}
          {x.serverId ? <NextLink href={`/servers/${x.serverId}`} className="rounded hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-accent">{x.description}</NextLink> : x.description}</span>)}
          {renewal.items.length > 2 && <> {t('more', { n: renewal.items.length - 2 })}</>}
          {renewal.items.length === 0 && renewal.servers > 0 && t('servers', { n: renewal.servers })}</>}/>}
      {spending.map((r) => <Row key={r.currency} icon={<I name="hourglass" size={15}/>} tone={r.empty ? 'danger' : r.soon ? 'warning' : 'default'} amount={money(r.amount, r.currency)}
        title={r.empty ? t('runOutEmpty') : t('runOut', { when: format.relativeTime(new Date(r.at), now) })}
        detail={<>{t('rate', { price: money(r.perHour, r.currency, 4) })}{!r.empty && <> · {format.dateTime(new Date(r.at), { dateStyle: 'medium', timeStyle: 'short' })}</>}</>}>
        {r.soon && s.methods.balance && <NextLink href={`/billing?tab=balance&topup=${Math.max(1, Math.ceil(r.perHour * 168))}`} className={`${action} bg-accent text-accent-foreground`}><I name="wallet" size={14}/>{t('topUp')}</NextLink>}
      </Row>)}
    </ul>
  </section>;
}
