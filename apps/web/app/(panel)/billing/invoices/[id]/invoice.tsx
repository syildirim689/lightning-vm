"use client";
// One invoice for the customer: the document, and while it awaits payment the ways to pay it (balance, a saved
// card, a card at a payment provider with 3D Secure, or a bank transfer). Back from the provider the result shows here.
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../../../components/icon';
import { InvoiceSheet } from '../../../../../components/invoice-sheet';
import { CheckboxInput, Mono, Notice } from '../../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../../lib/api';
import type { InvoiceDetail, Summary } from '../../../../../lib/billing';
import { useApiQuery } from '../../../../../lib/query';
import { useDocTitle } from '../../../../../lib/title';
import { InvoiceDisputes } from '../../disputes';
import { Copy } from '../../../server-extras';

export default function InvoicePage({ id }: { id: string }) {
  const t = useTranslations('Billing');
  const params = useSearchParams();
  const paymentId = params.get('payment');
  const q = useApiQuery<InvoiceDetail>(['billing', 'invoice', id], `/billing/invoices/${id}`, { refetchInterval: (d) => (d?.invoice.status === 'unpaid' && paymentId ? 3000 : false) });
  const d = q.data;
  useDocTitle(d && (d.invoice.number ?? `#${d.invoice.id.slice(0, 8).toUpperCase()}`));
  // Back from a provider: the result of that payment, once.
  const result = paymentId ? d?.payments.find((p) => p.id === paymentId) : undefined;
  useEffect(() => {
    if (result?.status === 'succeeded') toast.success(t('paidToast'));
    else if (result?.status === 'failed') toast.danger(t('failedToast'));
  }, [result?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="h-96 animate-pulse rounded-3xl bg-default/50"/>;
  return <div className="flex flex-col gap-5">
    <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
      <NextLink href="/billing" className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground"><I name="arrow-left" size={14}/>{t('back')}</NextLink>
      <Button size="sm" variant="secondary" onPress={() => window.print()}><I name="printer" size={14}/>{t('print')}</Button>
    </div>
    {result?.status === 'pending' && <Notice tone="default" title={t('checking')}>{t('checkingHelp')}</Notice>}
    {d.invoice.status === 'unpaid' && <PayPanel d={d}/>}
    <InvoiceSheet d={d}/>
    <InvoiceDisputes d={d}/>
  </div>;
}

function PayPanel({ d }: { d: InvoiceDetail }) {
  const t = useTranslations('Billing');
  const format = useFormatter();
  const router = useRouter();
  const client = useQueryClient();
  const { error } = useErrorText();
  const s = useApiQuery<Summary>(['notifications', 'billing-summary'], '/billing/summary').data;
  const [busy, setBusy] = useState<string | null>(null);
  const [save, setSave] = useState(true);
  if (!s?.enabled) return null;
  const inv = d.invoice;
  const due = Number(inv.total) - Number(inv.paidTotal);
  const money = (v: number | string, c = inv.currency) => format.number(Number(v), { style: 'currency', currency: c });
  const balance = Number(s.balance.find((b) => b.currency === inv.currency)?.amount ?? 0);
  const card = s.cards.find((c) => c.isDefault) ?? s.cards[0];
  const refresh = () => { void client.invalidateQueries({ queryKey: ['billing'] }); void client.invalidateQueries({ queryKey: ['notifications'] }); };
  async function pay(body: Record<string, unknown>, key: string) {
    setBusy(key);
    try {
      const r = await apiFetch<{ paid?: boolean; redirect?: string; html?: string }>(`/billing/invoices/${inv.id}/pay`, { method: 'POST', body });
      if (r.paid) { toast.success(t('paidToast')); refresh(); }
      else if (r.redirect) { if (/^https?:\/\//.test(r.redirect)) window.location.assign(r.redirect); else router.push(r.redirect); }
      else if (r.html) { document.open(); document.write(r.html); document.close(); } // a provider's self-submitting 3D form
    } catch (e) { toast.danger(error(e)); refresh(); } finally { setBusy(null); }
  }
  const failed = d.payments.find((p) => p.status === 'failed');
  return <section aria-labelledby="pay-title" className="rounded-3xl border border-accent/40 bg-accent/5 p-5 print:hidden">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="pay-title" className="text-lg font-semibold">{t('payTitle', { amount: money(due) })}</h2>
      <span className={`text-sm ${inv.overdue ? 'font-medium text-danger' : 'text-muted'}`}>{t('sheet.due', { date: format.dateTime(new Date(inv.dueAt), { dateStyle: 'medium', timeStyle: 'short' }) })}</span>
    </div>
    {inv.kind === 'order' && <p className="mt-1 text-sm text-muted">{t('orderWaits')}</p>}
    {failed && <p className="mt-2 flex items-center gap-1.5 text-sm text-danger"><I name="circle-alert" size={14}/>{t('lastFailed', { reason: t.has(`decline.${failed.errorCode}` as 'decline.CARD_DECLINED') ? t(`decline.${failed.errorCode}` as 'decline.CARD_DECLINED') : failed.errorMessage || failed.errorCode || '' })}</p>}
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      {s.methods.balance && inv.kind !== 'topup' && <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4">
        <p className="flex items-center gap-2 font-medium"><I name="wallet" size={16}/>{t('withBalance')}</p>
        <p className="text-sm text-muted">{t('balanceHas', { amount: money(balance) })}</p>
        <Button className="mt-auto" isDisabled={balance < due} isPending={busy === 'balance'} onPress={() => void pay({ method: 'balance' }, 'balance')}>{balance < due ? t('balanceShort') : t('payAmount', { amount: money(due) })}</Button>
      </div>}
      {card && <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4">
        <p className="flex items-center gap-2 font-medium"><I name="credit-card" size={16}/>{t('withSaved')}</p>
        <p className="text-sm text-muted">{card.brand ?? ''} •••• {card.last4}</p>
        <Button className="mt-auto" isPending={busy === 'saved'} onPress={() => void pay({ method: 'saved_card' }, 'saved')}>{t('payAmount', { amount: money(due) })}</Button>
      </div>}
      {s.methods.cards.length > 0 && <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 md:col-span-2">
        <p className="flex items-center gap-2 font-medium"><I name="shield-check" size={16}/>{t('withCard')}</p>
        <p className="text-sm text-muted">{t('withCardHelp')}</p>
        <div className="flex flex-wrap gap-2">{s.methods.cards.map((m) => <Button key={m.id} variant="secondary" isPending={busy === m.id} onPress={() => void pay({ method: 'card', provider: m.id, saveCard: save && m.saved && inv.kind !== 'topup' }, m.id)}>
          <I name="lock" size={14}/>{m.name}{m.mode === 'test' && <span className="text-xs text-warning">({t('testMode')})</span>}</Button>)}</div>
        {inv.kind !== 'topup' && <CheckboxInput label={t('saveCard')} isSelected={save} onChange={setSave} help={t('saveCardHelp')}/>}
      </div>}
      {s.methods.bankTransfer && <div className="flex flex-col gap-1 rounded-2xl border border-border bg-surface p-4 text-sm md:col-span-2">
        <p className="flex items-center gap-2 font-medium"><I name="landmark" size={16}/>{t('withTransfer')}</p>
        <p className="text-muted">{t('transferHelp')}</p>
        <p>{s.methods.bankTransfer.bank} · {s.methods.bankTransfer.holder}</p>
        <p className="flex flex-wrap items-center gap-1">IBAN: <Mono>{s.methods.bankTransfer.iban}</Mono><Copy text={s.methods.bankTransfer.iban.replace(/\s+/g, '')} label="IBAN"/></p>
        <p className="flex flex-wrap items-center gap-1">{t('transferNote')}: <Mono>{inv.id.slice(0, 8).toUpperCase()}</Mono><Copy text={inv.id.slice(0, 8).toUpperCase()} label={t('transferNote')}/></p>
        <p className="flex flex-wrap items-center gap-1">{t('transferAmount')}: <Mono>{money(due)}</Mono><Copy text={due.toFixed(2)} label={t('transferAmount')}/></p>
      </div>}
      {!s.methods.cards.length && !s.methods.bankTransfer && !(s.methods.balance && balance >= due) && !card && <Notice tone="warning">{t('noMethod')}</Notice>}
    </div>
  </section>;
}
