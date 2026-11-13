"use client";
// Settings → Billing: turning billing on, the seller on every invoice, tax, the number series, when renewals are
// invoiced and collected, the steps for unpaid invoices, balance and bank transfer, and the sandbox test provider.
import { Button, Card, toast } from '@heroui/react';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../../components/icon';
import { FormActions, FormSection, Notice, SwitchInput, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Company = { name: string; taxId: string; taxOffice: string; address: string; district: string; city: string; country: string; postalCode: string; phone: string; email: string; website: string; mersis: string; tradeRegistry: string };
type Doc = { enabled: boolean; requirePayment: boolean; orderExpiryHours: number; taxRate: number; pricesIncludeTax: boolean; exportExempt: boolean; invoicePrefix: string;
  invoiceDaysBefore: number; reminderDays: number[]; suspendAfterDays: number; terminateAfterDays: number; autoCharge: boolean; chargeRetries: number; balance: boolean;
  topupMin: number; topupMax: number; sandbox: boolean; hourly: boolean; hourlyMinHours: number; disputeWindowDays: number; disputeAnswerDays: number; bankTransfer: { enabled: boolean; bank: string; holder: string; iban: string }; company: Company };

export default function BillingSettings({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.billing');
  const tf = useTranslations('Formats');
  const { error, field } = useErrorText();
  const q = useApiQuery<{ billing: Doc }>(['settings', 'billing'], '/admin/settings/billing').data;
  const [v, setV] = useState<Doc | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q && !v) setV(q.billing); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return <p role="status" className="text-sm text-muted">…</p>;
  const num = (k: keyof Doc) => (x: string) => setV({ ...v, [k]: Number(x.replace(/\D/g, '')) || 0 });
  const co = (k: keyof Company) => (x: string) => setV({ ...v, company: { ...v.company, [k]: x } });
  const toggle = (k: keyof Doc, label: string, help: string) => <div className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
    <div><p className="text-sm font-medium">{label}</p><p className="text-xs text-muted">{help}</p></div>
    <SwitchInput label={<span className="sr-only">{label}</span>} isSelected={v[k] as boolean} isDisabled={readOnly} onChange={(x) => setV({ ...v, [k]: x })}/>
  </div>;
  async function save() {
    setBusy(true); setErrors({});
    try { const r = await apiFetch<{ billing: Doc }>('/admin/settings/billing', { method: 'PUT', body: v }); setV(r.billing); toast.success(t('saved')); }
    catch (e) { const f = (e as { fields?: Record<string, string> }).fields ?? {}; setErrors(Object.fromEntries(Object.entries(f).map(([k, c]) => [k, field(c) ?? c]))); toast.danger(Object.keys(f).length ? t('fixFields') : error(e)); }
    finally { setBusy(false); }
  }
  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('main')} description={t('mainHelp')} icon={<I name="receipt" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {toggle('enabled', t('enabled'), t('enabledHelp'))}
        {toggle('requirePayment', t('requirePayment'), t('requirePaymentHelp'))}
        {toggle('autoCharge', t('autoCharge'), t('autoChargeHelp'))}
        {toggle('balance', t('balance'), t('balanceHelp'))}
        {toggle('hourly', t('hourly'), t('hourlyHelp'))}
        <TextInput format="integer" unit={tf('unit.days')} label={t('disputeWindowDays')} value={String(v.disputeWindowDays ?? 60)} onChange={num('disputeWindowDays')} error={errors.disputeWindowDays} isDisabled={readOnly} help={t('disputeWindowHelp')}/>
        <TextInput format="integer" unit={tf('unit.days')} label={t('disputeAnswerDays')} value={String(v.disputeAnswerDays ?? 7)} onChange={num('disputeAnswerDays')} error={errors.disputeAnswerDays} isDisabled={readOnly} help={t('disputeAnswerHelp')}/>
        {v.hourly && <TextInput format="integer" unit={tf('unit.hours')} label={t('hourlyMinHours')} value={String(v.hourlyMinHours ?? 24)} onChange={num('hourlyMinHours')} error={errors.hourlyMinHours} isDisabled={readOnly} help={t('hourlyMinHoursHelp')}/>}
      </div>
      <Notice tone="default">{t('providers')} <NextLink href="/admin/settings?tab=payments" className="font-medium text-accent hover:underline">{t('providersLink')}</NextLink></Notice>
    </FormSection>
    <FormSection title={t('company')} description={t('companyHelp')} icon={<I name="building" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput label={t('companyName')} value={v.company.name} onChange={co('name')} error={errors['company.name']} isDisabled={readOnly} isRequired autoComplete="off"/>
        <TextInput format="vkn" label="VKN" value={v.company.taxId} onChange={co('taxId')} isDisabled={readOnly} isRequired autoComplete="off"/>
        <TextInput label={t('taxOffice')} value={v.company.taxOffice} onChange={co('taxOffice')} isDisabled={readOnly} autoComplete="off"/>
        <TextInput label="MERSİS" value={v.company.mersis} onChange={co('mersis')} isDisabled={readOnly} autoComplete="off"/>
        <div className="sm:col-span-2"><TextInput label={t('address')} value={v.company.address} onChange={co('address')} isDisabled={readOnly} isRequired autoComplete="off"/></div>
        <TextInput label={t('district')} value={v.company.district} onChange={co('district')} isDisabled={readOnly} autoComplete="off"/>
        <TextInput label={t('city')} value={v.company.city} onChange={co('city')} isDisabled={readOnly} autoComplete="off"/>
        <TextInput format="phone" label={t('phone')} value={v.company.phone} onChange={co('phone')} isDisabled={readOnly} autoComplete="off"/>
        <TextInput format="email" label={t('email')} value={v.company.email} onChange={co('email')} isDisabled={readOnly} autoComplete="off"/>
        <TextInput format="url" label={t('website')} value={v.company.website} onChange={co('website')} isDisabled={readOnly} help={t('websiteHelp')} autoComplete="off"/>
        <TextInput label={t('tradeRegistry')} value={v.company.tradeRegistry} onChange={co('tradeRegistry')} isDisabled={readOnly} autoComplete="off"/>
      </div>
    </FormSection>
    <FormSection title={t('tax')} description={t('taxHelp')} icon={<I name="percent" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextInput format="decimal" unit="%" label={t('taxRate')} value={String(v.taxRate)} onChange={num('taxRate')} error={errors.taxRate} isDisabled={readOnly} autoComplete="off"/>
        <TextInput label={t('prefix')} value={v.invoicePrefix} onChange={(x) => setV({ ...v, invoicePrefix: x.toUpperCase().slice(0, 3) })} error={errors.invoicePrefix} help={t('prefixHelp', { example: `${v.invoicePrefix}${new Date().getFullYear()}000000001` })} isDisabled={readOnly} autoComplete="off"/>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {toggle('pricesIncludeTax', t('pricesIncludeTax'), t('pricesIncludeTaxHelp'))}
        {toggle('exportExempt', t('exportExempt'), t('exportExemptHelp'))}
      </div>
    </FormSection>
    <FormSection title={t('collection')} description={t('collectionHelp')} icon={<I name="calendar-clock" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextInput format="integer" unit={tf('unit.days')} label={t('invoiceDaysBefore')} value={String(v.invoiceDaysBefore)} onChange={num('invoiceDaysBefore')} error={errors.invoiceDaysBefore} isDisabled={readOnly} autoComplete="off"/>
        <TextInput unit={tf('unit.days')} label={t('reminderDays')} value={v.reminderDays.join(', ')} onChange={(x) => setV({ ...v, reminderDays: x.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n)) })} help={t('reminderDaysHelp')} isDisabled={readOnly} autoComplete="off"/>
        <TextInput format="integer" unit={tf('unit.times')} label={t('chargeRetries')} value={String(v.chargeRetries)} onChange={num('chargeRetries')} error={errors.chargeRetries} isDisabled={readOnly} autoComplete="off"/>
        <TextInput format="integer" unit={tf('unit.days')} label={t('suspendAfterDays')} value={String(v.suspendAfterDays)} onChange={num('suspendAfterDays')} error={errors.suspendAfterDays} isDisabled={readOnly} autoComplete="off"/>
        <TextInput format="integer" unit={tf('unit.days')} label={t('terminateAfterDays')} value={String(v.terminateAfterDays)} onChange={num('terminateAfterDays')} error={errors.terminateAfterDays} help={t('terminateHelp')} isDisabled={readOnly} autoComplete="off"/>
        <TextInput format="integer" unit={tf('unit.hours')} label={t('orderExpiryHours')} value={String(v.orderExpiryHours)} onChange={num('orderExpiryHours')} error={errors.orderExpiryHours} isDisabled={readOnly} autoComplete="off"/>
      </div>
      <ol className="flex flex-wrap items-center gap-2 text-xs text-muted" aria-label={t('timeline')}>
        {[t('step.invoice', { n: v.invoiceDaysBefore }), t('step.due'), t('step.overdue'), t('step.suspend', { n: v.suspendAfterDays }), v.terminateAfterDays ? t('step.terminate', { n: v.terminateAfterDays }) : t('step.never')].map((s, i, all) =>
          <li key={i} className="flex items-center gap-2"><span className="rounded-full bg-default px-2.5 py-1">{s}</span>{i < all.length - 1 && <I name="chevron-right" size={12}/>}</li>)}
      </ol>
    </FormSection>
    <FormSection title={t('balanceAndTransfer')} description={t('balanceAndTransferHelp')} icon={<I name="landmark" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput format="money" label={t('topupMin')} value={String(v.topupMin)} onChange={num('topupMin')} error={errors.topupMin} isDisabled={readOnly} autoComplete="off"/>
        <TextInput format="money" label={t('topupMax')} value={String(v.topupMax)} onChange={num('topupMax')} error={errors.topupMax} isDisabled={readOnly} autoComplete="off"/>
      </div>
      <div className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
        <div><p className="text-sm font-medium">{t('bankTransfer')}</p><p className="text-xs text-muted">{t('bankTransferHelp')}</p></div>
        <SwitchInput label={<span className="sr-only">{t('bankTransfer')}</span>} isSelected={v.bankTransfer.enabled} isDisabled={readOnly} onChange={(x) => setV({ ...v, bankTransfer: { ...v.bankTransfer, enabled: x } })}/>
      </div>
      {v.bankTransfer.enabled && <div className="grid gap-3 sm:grid-cols-3">
        <TextInput label={t('bank')} value={v.bankTransfer.bank} onChange={(x) => setV({ ...v, bankTransfer: { ...v.bankTransfer, bank: x } })} isDisabled={readOnly} autoComplete="off"/>
        <TextInput label={t('holder')} value={v.bankTransfer.holder} onChange={(x) => setV({ ...v, bankTransfer: { ...v.bankTransfer, holder: x } })} isDisabled={readOnly} autoComplete="off"/>
        <TextInput format="iban" label="IBAN" value={v.bankTransfer.iban} onChange={(x) => setV({ ...v, bankTransfer: { ...v.bankTransfer, iban: x } })} error={errors['bankTransfer.iban']} isDisabled={readOnly} autoComplete="off"/>
      </div>}
    </FormSection>
    <FormSection title={t('testing')} description={t('testingHelp')} icon={<I name="flask-conical" size={16}/>}>
      {toggle('sandbox', t('sandbox'), t('sandboxHelp'))}
    </FormSection>
    {!readOnly && <FormActions><Button isPending={busy} onPress={() => void save()}><I name="check" size={16}/>{t('save')}</Button></FormActions>}
  </Card.Content></Card>;
}
