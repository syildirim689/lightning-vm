"use client";
// The sandbox provider's payment page (test mode only): it plays a bank's 3D Secure page with test cards, so the
// whole flow (declined, approved, saved card, automatic charges) can be tried without a real provider.
import { Button, toast } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../../../components/icon';
import { Mono, Notice, TextInput, Loading } from '../../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../../lib/api';
import { useApiQuery } from '../../../../../lib/query';

type P = { id: string; invoiceId: string; provider: string; status: string; amount: string; currency: string; saveCard: boolean };

export default function Checkout({ id }: { id: string }) {
  const t = useTranslations('Billing.checkout');
  const format = useFormatter();
  const router = useRouter();
  const { error } = useErrorText();
  const p = useApiQuery<{ payment: P }>(['billing', 'payment', id], `/billing/payments/${id}`).data?.payment;
  const [card, setCard] = useState('4242 4242 4242 4242');
  const [busy, setBusy] = useState(false);
  if (!p) return <Loading of={['billing', 'payment', id]}><div className="mx-auto h-80 max-w-md animate-pulse rounded-3xl bg-default/50"/></Loading>;
  async function submit(cancel = false) {
    setBusy(true);
    try {
      const r = await apiFetch<{ status: string; code?: string }>(`/billing/payments/${id}/sandbox`, { method: 'POST', body: cancel ? { cancel: true } : { card } });
      if (r.status === 'failed' && !cancel) toast.danger(t('declined'));
      router.replace(`/billing/invoices/${p!.invoiceId}?payment=${id}`);
    } catch (e) { toast.danger(error(e)); setBusy(false); }
  }
  return <div className="mx-auto flex max-w-md flex-col gap-4">
    <div className="rounded-3xl border border-border bg-surface p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <span className="flex items-center gap-2 font-semibold"><I name="shield-check" size={18} className="text-success"/>{t('title')}</span>
        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">{t('test')}</span>
      </div>
      <p className="text-sm text-muted">{t('amount')}</p>
      <p className="mb-4 text-3xl font-semibold tabular-nums">{format.number(Number(p.amount), { style: 'currency', currency: p.currency })}</p>
      {p.status !== 'pending' ? <Notice tone="default">{t('done')}</Notice> : <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <TextInput label={t('card')} value={card} onChange={setCard} autoComplete="off"/>
        <div className="flex gap-2">
          <Button type="submit" className="flex-1" isPending={busy}><I name="lock" size={14}/>{t('pay')}</Button>
          <Button variant="tertiary" isDisabled={busy} onPress={() => void submit(true)}>{t('cancel')}</Button>
        </div>
      </form>}
    </div>
    <div className="rounded-2xl border border-dashed border-border p-4 text-sm">
      <p className="mb-2 font-medium">{t('cards')}</p>
      <ul className="flex flex-col gap-1">
        {([['4242 4242 4242 4242', 'ok'], ['4000 0000 0000 0002', 'declined'], ['4000 0000 0000 9995', 'funds'], ['4000 0000 0000 4954', 'review']] as const).map(([n, k]) =>
          <li key={n}><button type="button" className="hover:underline" onClick={() => setCard(n)}><Mono>{n}</Mono></button> · {t(`card_${k}`)}</li>)}
      </ul>
    </div>
  </div>;
}
