"use client";
// Staff: accounts whose payments are at risk (GET /admin/billing/risk): overdue invoices or repeated failed charges,
// the largest amount first, each row with the numbers that put it on the list and a link to the account's invoices.
// A list to look through; nothing is sent or suspended from here.
import { useFormatter, useTranslations } from 'next-intl';
import { useApiQuery } from '../lib/query';
import { I } from './icon';
import { ButtonLink, DataTable, StatusChip } from './ui';

type Row = { userId: string; email: string; currency: string; atRisk: number; overdue: number; overdueCount: number; oldestDays: number; newOverdue: number; failedCharges: number; failedAmount: number;
  reasons: ('OVERDUE' | 'OVERDUE_GROWING' | 'REPEATED_FAILURES')[] };
type Risk = { accounts: Row[]; rule: { lookaheadDays: number; failedDays: number; minFailures: number; growthDays: number } };

export function PaymentRisk() {
  const t = useTranslations('PaymentRisk');
  const format = useFormatter();
  const d = useApiQuery<Risk>(['admin', 'billing', 'risk'], '/admin/billing/risk', { refetchInterval: 120_000 }).data;
  if (!d) return null;
  const money = (v: number, currency: string) => format.number(v, { style: 'currency', currency: currency.trim() });
  return <section aria-labelledby="payment-risk-title" className="flex flex-col gap-3">
    <div>
      <h2 id="payment-risk-title" className="text-base font-semibold">{t('title')}</h2>
      <p className="text-sm text-muted">{t('help', { failures: d.rule.minFailures, days: d.rule.failedDays })}</p>
    </div>
    <DataTable label={t('title')} rows={d.accounts} rowKey={(r) => `${r.userId}:${r.currency}`} empty={t('none')} minWidth={760}
      columns={[{ id: 'a', label: t('account') }, { id: 'r', label: t('atRisk') }, { id: 'o', label: t('overdue') }, { id: 'f', label: t('failed', { days: d.rule.failedDays }) }, { id: 'w', label: t('why') }, { id: 'x', label: <span className="sr-only">{t('actions')}</span> }]}
      cells={(r) => [
        <span key="a" className="font-medium [overflow-wrap:anywhere]">{r.email}</span>,
        <span key="r" className="font-semibold tabular-nums">{money(r.atRisk, r.currency)}</span>,
        r.overdueCount > 0 ? <span key="o" className="flex flex-col"><span className="tabular-nums">{money(r.overdue, r.currency)}</span>
          <span className="text-xs text-muted">{t('overdueLine', { n: r.overdueCount, days: r.oldestDays })}</span>
          {r.newOverdue > 0 && r.newOverdue < r.overdue && <span className="text-xs text-warning">{t('newLine', { amount: money(r.newOverdue, r.currency), days: d.rule.growthDays })}</span>}</span>
          : <span key="o" className="text-muted">{t('noOverdue')}</span>,
        <span key="f" className={r.failedCharges >= d.rule.minFailures ? 'text-danger' : 'text-muted'}>{t('failedLine', { n: r.failedCharges })}</span>,
        <span key="w" className="flex flex-wrap gap-1">{r.reasons.map((x) => <StatusChip key={x} tone={x === 'OVERDUE' ? 'warning' : 'danger'}>{t(`reason.${x}`)}</StatusChip>)}</span>,
        <ButtonLink key="x" size="sm" variant="ghost" href={`/admin/billing?tab=invoices&q=${encodeURIComponent(r.email)}`}><I name="receipt-text" size={13}/>{t('invoices')}</ButtonLink>]}/>
  </section>;
}
