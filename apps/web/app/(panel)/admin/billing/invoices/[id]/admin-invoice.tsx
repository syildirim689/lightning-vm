"use client";
// One invoice for staff: the document and what can be done with it: record a payment made outside the panel,
// withdraw it while nothing is paid, or refund (to the card through the provider, or to the balance).
import { Button, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../../../../components/icon';
import { InvoiceSheet } from '../../../../../../components/invoice-sheet';
import { CheckboxInput, ConfirmButton, Notice, SelectInput, TextInput } from '../../../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../../../lib/api';
import type { InvoiceDetail } from '../../../../../../lib/billing';
import { useMe } from '../../../../../../lib/me';
import { can } from '../../../../../../lib/permissions';
import { useApiQuery } from '../../../../../../lib/query';

export default function AdminInvoice({ id }: { id: string }) {
  const t = useTranslations('BillingAdmin');
  const format = useFormatter();
  const client = useQueryClient();
  const { error, field } = useErrorText();
  const manage = can(useMe()?.permissions, 'billing.manage');
  const d = useApiQuery<InvoiceDetail>(['admin', 'billing', 'invoice', id], `/admin/billing/invoices/${id}`).data;
  const [dialog, setDialog] = useState<'paid' | 'refund' | null>(null);
  const [v, setV] = useState({ method: 'bank_transfer', reference: '', amount: '', reason: '', toBalance: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (!d) return <div className="h-96 animate-pulse rounded-3xl bg-default/50"/>;
  const inv = d.invoice;
  const reload = () => { void client.invalidateQueries({ queryKey: ['admin', 'billing'] }); };
  async function post(path: string, body: object, done: string) {
    setBusy(true); setErrors({});
    try { await apiFetch(path, { method: 'POST', body }); toast.success(done); setDialog(null); reload(); }
    catch (e) { const f = (e as { fields?: Record<string, string> }).fields ?? {}; setErrors(Object.fromEntries(Object.entries(f).map(([k, c]) => [k, field(c) ?? c]))); if (!Object.keys(f).length) toast.danger(error(e)); }
    finally { setBusy(false); }
  }
  const left = Number(inv.total) - Number(inv.refundedTotal);
  return <div className="flex flex-col gap-5">
    <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
      <NextLink href="/admin/billing" className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground"><I name="arrow-left" size={14}/>{t('title')}</NextLink>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onPress={() => window.print()}><I name="printer" size={14}/>{t('print')}</Button>
        {manage && ['failed', 'rejected'].includes(inv.einvoiceStatus) && <Button size="sm" variant="secondary" isPending={busy} onPress={() => void post(`/admin/billing/invoices/${id}/einvoice/retry`, {}, t('resent'))}><I name="refresh-cw" size={14}/>{t('resend')}</Button>}
        {manage && inv.status === 'unpaid' && <Button size="sm" onPress={() => setDialog('paid')}><I name="badge-check" size={14}/>{t('markPaid')}</Button>}
        {manage && inv.status === 'unpaid' && Number(inv.paidTotal) === 0 && <ConfirmButton size="sm" variant="danger-soft" icon={<I name="ban" size={14}/>} label={t('withdraw')} title={t('withdrawTitle')}
          body={t('withdrawBody')} confirmLabel={t('withdraw')} cancelLabel={t('cancel')} onConfirm={() => post(`/admin/billing/invoices/${id}/cancel`, {}, t('withdrawn'))}/>}
        {manage && ['paid', 'partially_refunded'].includes(inv.status) && <Button size="sm" variant="secondary" onPress={() => { setV({ ...v, amount: left.toFixed(2) }); setDialog('refund'); }}><I name="undo-2" size={14}/>{t('refund')}</Button>}
      </div>
    </div>
    {inv.einvoiceError && <Notice tone="danger" title={t('einvoiceFailed')}>{inv.einvoiceError}</Notice>}
    <InvoiceSheet d={d}/>
    {dialog && <Modal.Backdrop isOpen onOpenChange={(o) => { if (!o) setDialog(null); }}>
      <Modal.Container><Modal.Dialog>
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading>{dialog === 'paid' ? t('markPaid') : t('refund')}</Modal.Heading></Modal.Header>
        <Modal.Body className="flex flex-col gap-4">
          {dialog === 'paid' ? <>
            <p className="text-sm text-muted">{t('markPaidHelp', { amount: format.number(Number(inv.total) - Number(inv.paidTotal), { style: 'currency', currency: inv.currency }) })}</p>
            <SelectInput label={t('method')} value={v.method} onChange={(x) => setV({ ...v, method: x })} options={(['bank_transfer', 'cash', 'other'] as const).map((m) => ({ id: m, label: t(`methods.${m}`) }))}/>
            <TextInput label={t('reference')} value={v.reference} onChange={(x) => setV({ ...v, reference: x })} help={t('referenceHelp')} autoComplete="off"/>
          </> : <>
            <p className="text-sm text-muted">{t('refundHelp', { amount: format.number(left, { style: 'currency', currency: inv.currency }) })}</p>
            <TextInput label={t('amount')} value={v.amount} onChange={(x) => setV({ ...v, amount: x })} error={errors.amount} autoComplete="off"/>
            <TextInput label={t('reason')} value={v.reason} onChange={(x) => setV({ ...v, reason: x })} autoComplete="off"/>
            {inv.kind !== 'topup' && <CheckboxInput label={t('toBalance')} isSelected={v.toBalance} onChange={(x) => setV({ ...v, toBalance: x })} help={t('toBalanceHelp')}/>}
          </>}
        </Modal.Body>
        <Modal.Footer><Button variant="tertiary" onPress={() => setDialog(null)}>{t('cancel')}</Button>
          <Button isPending={busy} onPress={() => void (dialog === 'paid'
            ? post(`/admin/billing/invoices/${id}/mark-paid`, { method: v.method, reference: v.reference }, t('recorded'))
            : post(`/admin/billing/invoices/${id}/refund`, { amount: v.amount.replace(',', '.'), reason: v.reason, toBalance: v.toBalance }, t('refunded')))}>
            <I name="check" size={16}/>{dialog === 'paid' ? t('record') : t('refund')}</Button></Modal.Footer>
      </Modal.Dialog></Modal.Container>
    </Modal.Backdrop>}
  </div>;
}
