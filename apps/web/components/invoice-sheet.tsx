"use client";
// One invoice as a document (the customer's and the staff's invoice pages, and printing): seller and buyer, the lines
// with KDV, the totals and the payments. Before it is paid it is a pro forma marked "awaiting payment" with no number.
import { useFormatter, useTranslations } from 'next-intl';
import { usePercent } from '../lib/percent';
import type { InvoiceDetail, Party } from '../lib/billing';
import { invoiceState, invoiceTone, paymentState, paymentTone } from '../lib/billing';
import { I } from './icon';
import { StatusChip } from './ui';

function PartyBlock({ title, p }: { title: string; p: Party }) {
  const t = useTranslations('Billing.sheet');
  const anon = p.taxId === '11111111111';
  return <div className="min-w-0">
    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</p>
    <p className="font-semibold">{p.name || '–'}</p>
    {p.address && <p className="text-sm text-muted">{[p.address, p.district, p.city, p.postalCode, p.country !== 'TR' && p.country].filter(Boolean).join(', ')}</p>}
    {!anon && p.taxId && <p className="text-sm">{p.taxId.length === 11 ? 'TCKN' : t('taxId')}: <span className="font-mono">{p.taxId}</span>{p.taxOffice && ` · ${t('taxOffice')}: ${p.taxOffice}`}</p>}
    {p.mersis && <p className="text-xs text-muted">MERSİS: {p.mersis}{p.tradeRegistry && ` · ${t('tradeRegistry')}: ${p.tradeRegistry}`}</p>}
    {(p.email || p.phone || p.website) && <p className="text-xs text-muted">{[p.email, p.phone, p.website].filter(Boolean).join(' · ')}</p>}
  </div>;
}

// A cell of the lines table on a phone: its column's name on the left, the value on the right.
const stacked = 'max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-4 max-sm:p-0 max-sm:before:text-xs max-sm:before:font-normal max-sm:before:text-muted max-sm:before:content-[attr(data-label)]';

export function InvoiceSheet({ d }: { d: InvoiceDetail }) {
  const t = useTranslations('Billing');
  const format = useFormatter();
  const percent = usePercent();
  const inv = d.invoice;
  const money = (v: string) => format.number(Number(v), { style: 'currency', currency: inv.currency });
  const day = (v: string) => format.dateTime(new Date(v), { dateStyle: 'medium' });
  const state = invoiceState(inv);
  return <article className="invoice-sheet rounded-3xl border border-border bg-surface p-5 sm:p-8" aria-label={t('sheet.label')}>
    <header className="flex flex-col gap-4 border-b border-separator pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{inv.kind === 'topup' ? t('sheet.receipt') : inv.number ? (inv.einvoiceProfile === 'EARSIVFATURA' ? t('sheet.earsiv') : inv.einvoiceProfile ? t('sheet.efatura') : t('sheet.invoice')) : t('sheet.proforma')}</p>
        <h2 className="mt-1 font-mono text-xl font-semibold">{inv.number ?? `#${inv.id.slice(0, 8).toUpperCase()}`}</h2>
        <p className="mt-1 text-sm text-muted">{inv.issuedAt ? t('sheet.issued', { date: day(inv.issuedAt) }) : t('sheet.created', { date: day(inv.createdAt) })}
          {inv.status === 'unpaid' && ` · ${t('sheet.due', { date: day(inv.dueAt) })}`}</p>
      </div>
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <StatusChip tone={invoiceTone(inv)}>{t(`status.${state}`)}</StatusChip>
        {inv.einvoiceStatus !== 'none' && <span className="flex items-center gap-1 text-xs text-muted"><I name="file-check-2" size={13}/>{t(`einvoice.${inv.einvoiceStatus as 'sent'}`)}</span>}
        {['sent', 'accepted', 'cancelled'].includes(inv.einvoiceStatus) && <a href={`/api/billing/invoices/${inv.id}/einvoice.pdf`} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline print:hidden"><I name="file-down" size={13}/>{t('sheet.official')}</a>}
      </div>
    </header>
    <div className="grid gap-5 border-b border-separator py-5 sm:grid-cols-2">
      <PartyBlock title={t('sheet.seller')} p={inv.seller}/>
      <PartyBlock title={t('sheet.buyer')} p={inv.buyer}/>
    </div>
    {/* Phones: each line is a block with its figures under their names (five columns do not fit and would be cut off);
        the same table, laid out by CSS, so every value is in the page once. */}
    <div className="py-3 sm:overflow-x-auto sm:py-5">
      <table className="w-full text-sm max-sm:block sm:min-w-[560px]">
        <thead className="max-sm:sr-only"><tr className="border-b border-separator text-left text-xs text-muted">
          <th className="py-2 pr-3 font-medium">{t('sheet.description')}</th><th className="py-2 pr-3 text-right font-medium">{t('sheet.quantity')}</th>
          <th className="py-2 pr-3 text-right font-medium">{t('sheet.unitPrice')}</th><th className="py-2 pr-3 text-right font-medium">KDV</th><th className="py-2 text-right font-medium">{t('sheet.amount')}</th>
        </tr></thead>
        <tbody className="max-sm:block">{d.lines.map((l, i) => <tr key={i} className="border-b border-separator/60 align-top max-sm:flex max-sm:flex-col max-sm:gap-1 max-sm:py-3">
          <td className="py-2.5 pr-3 max-sm:p-0 max-sm:font-medium max-sm:[overflow-wrap:anywhere]">{l.description}</td>
          <td data-label={t('sheet.quantity')} className={`py-2.5 pr-3 text-right tabular-nums ${stacked}`}>{format.number(Number(l.quantity))} {l.unit === 'MON' ? t('sheet.month') : t('sheet.piece')}</td>
          <td data-label={t('sheet.unitPrice')} className={`py-2.5 pr-3 text-right tabular-nums ${stacked}`}>{money(l.unitPrice)}</td>
          <td data-label="KDV" className={`py-2.5 pr-3 text-right tabular-nums ${stacked}`}>{percent(Number(l.taxRate), 2)}</td>
          <td data-label={t('sheet.amount')} className={`py-2.5 text-right tabular-nums max-sm:font-medium ${stacked}`}>{money(l.net)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className="flex flex-col gap-4 sm:flex-row sm:justify-between">
      <div className="text-xs text-muted sm:max-w-sm">
        {inv.taxExemption && <p>{t('sheet.exemption', { code: inv.taxExemption })}</p>}
        {inv.note && <p className="mt-1 whitespace-pre-wrap">{inv.note}</p>}
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm sm:min-w-64">
        <dt className="text-muted">{t('sheet.subtotal')}</dt><dd className="text-right tabular-nums">{money(inv.subtotal)}</dd>
        <dt className="text-muted">KDV</dt><dd className="text-right tabular-nums">{money(inv.taxTotal)}</dd>
        <dt className="border-t border-separator pt-1.5 font-semibold">{t('sheet.total')}</dt><dd className="border-t border-separator pt-1.5 text-right text-lg font-semibold tabular-nums">{money(inv.total)}</dd>
        {Number(inv.paidTotal) > 0 && inv.status === 'unpaid' && <><dt className="text-muted">{t('sheet.paid')}</dt><dd className="text-right tabular-nums">{money(inv.paidTotal)}</dd></>}
        {Number(inv.refundedTotal) > 0 && <><dt className="text-muted">{t('sheet.refunded')}</dt><dd className="text-right tabular-nums text-accent">−{money(inv.refundedTotal)}</dd></>}
      </dl>
    </div>
    {d.payments.length > 0 && <section className="mt-6 border-t border-separator pt-5 print:hidden">
      <h3 className="mb-2 text-sm font-semibold">{t('sheet.payments')}</h3>
      <ul className="flex flex-col gap-1.5 text-sm">{d.payments.map((p) => <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusChip tone={paymentTone(paymentState(p))}>{t(`payment.${paymentState(p) as 'succeeded'}`)}</StatusChip>
        <span className="tabular-nums">{format.number(Number(p.amount), { style: 'currency', currency: p.currency })}</span>
        <span className="text-muted">{t(`method.${p.method as 'card'}`)}{p.provider !== 'balance' && p.provider !== 'manual' && ` · ${p.provider}`}{p.mode === 'test' && ` · ${t('testMode')}`}{p.automatic && ` · ${t('automatic')}`}</span>
        {p.reference && p.status !== 'cancelled' && <span className="font-mono text-xs text-muted">{p.reference}</span>}
        {p.errorCode && p.status !== 'cancelled' && <span className="text-xs text-danger">{t.has(`decline.${p.errorCode}` as 'decline.CARD_DECLINED') ? t(`decline.${p.errorCode}` as 'decline.CARD_DECLINED') : p.errorMessage || p.errorCode}</span>}
        <time className="ml-auto text-xs text-muted" dateTime={p.createdAt}>{format.dateTime(new Date(p.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</time>
      </li>)}</ul>
    </section>}
  </article>;
}
