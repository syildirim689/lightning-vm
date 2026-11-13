"use client";
// Invoice disputes: the customer opens one from an invoice (reason, lines, amount, message, files) and follows it; staff
// take it into review and decide. The conversation itself is the dispute's support ticket.
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { I } from '../../../components/icon';
import { CheckboxInput, ConfirmButton, DataTable, Empty, Notice, SelectInput, StatusChip, TextInput, type Tone } from '../../../components/ui';
import { apiFetch, type ApiError, useErrorText } from '../../../lib/api';
import type { InvoiceDetail } from '../../../lib/billing';
import { useApiQuery } from '../../../lib/query';
import { accept, readFile } from '../support/ui';

export type Dispute = { id: string; number: number; invoiceId: string; invoiceNumber: string | null; invoiceTotal: string; invoiceStatus: string; ticketId: string | null; reason: string;
  amount: string; currency: string; lineIds: string[]; status: 'open' | 'under_review' | 'accepted' | 'partially_accepted' | 'rejected' | 'withdrawn'; remedy: 'balance' | 'refund' | 'cancel' | null;
  resolvedAmount: string | null; resolution: string | null; dueAt: string; decidedAt: string | null; createdAt: string; overdue: boolean; email?: string };
const reasons = ['wrong_amount', 'not_used', 'duplicate', 'service_problem', 'cancelled', 'tax_details', 'other'] as const;
export const disputeTone = (s: Dispute['status']): Tone =>
  ({ open: 'warning', under_review: 'accent', accepted: 'success', partially_accepted: 'success', rejected: 'danger', withdrawn: 'default' } as const)[s];
const isOpen = (d: Dispute) => d.status === 'open' || d.status === 'under_review';

// The steps a dispute went through, as a short timeline.
function Steps({ d }: { d: Dispute }) {
  const t = useTranslations('Disputes');
  const format = useFormatter();
  const when = (x: string) => format.dateTime(new Date(x), { dateStyle: 'medium', timeStyle: 'short' });
  const steps = [{ key: 'opened', done: true, at: d.createdAt }, { key: 'review', done: d.status !== 'open', at: null },
    { key: 'decided', done: !isOpen(d), at: d.decidedAt }];
  return <ol className="flex flex-wrap items-center gap-2 text-xs" aria-label={t('steps.label')}>
    {steps.map((s, i) => <li key={s.key} className="flex items-center gap-2">
      <span className={`grid size-5 place-items-center rounded-full ${s.done ? 'bg-success text-success-foreground' : 'bg-default text-muted'}`}>{s.done ? <I name="check" size={11}/> : i + 1}</span>
      <span className={s.done ? '' : 'text-muted'}>{t(`steps.${s.key as 'opened'}`)}{s.at && <span className="text-muted"> · {when(s.at)}</span>}</span>
      {i < steps.length - 1 && <span aria-hidden className="h-px w-6 bg-separator"/>}
    </li>)}
  </ol>;
}

function DisputeCard({ d, onChanged, admin }: { d: Dispute; onChanged: () => void; admin?: boolean }) {
  const t = useTranslations('Disputes');
  const format = useFormatter();
  const { error } = useErrorText();
  const money = (v: string) => format.number(Number(v), { style: 'currency', currency: d.currency });
  async function withdraw() {
    try { await apiFetch(`/billing/disputes/${d.id}/withdraw`, { method: 'POST' }); toast.success(t('withdrawn')); onChanged(); } catch (e) { toast.danger(error(e)); }
  }
  return <div className={`flex flex-col gap-3 rounded-2xl border p-4 ${d.overdue ? 'border-danger/40' : 'border-border'}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-semibold">{t('title', { number: d.number })} · {t(`reason.${d.reason as 'other'}`)}</p>
      <StatusChip tone={disputeTone(d.status)}>{t(`status.${d.status}`)}</StatusChip>
    </div>
    <Steps d={d}/>
    <dl className="grid gap-2 text-sm sm:grid-cols-3">
      <div><dt className="text-muted">{t('amount')}</dt><dd className="font-medium tabular-nums">{money(d.amount)}</dd></div>
      {isOpen(d) ? <div><dt className="text-muted">{t('decisionBy')}</dt><dd className={d.overdue ? 'text-danger' : ''}>{format.dateTime(new Date(d.dueAt), { dateStyle: 'medium' })}</dd></div>
        : d.resolvedAmount ? <div><dt className="text-muted">{t('resolved')}</dt><dd className="font-medium text-success">{money(d.resolvedAmount)} · {t(`remedy.${d.remedy ?? 'balance'}`)}</dd></div> : null}
      {d.ticketId && <div><dt className="text-muted">{t('conversation')}</dt><dd><NextLink href={admin ? `/admin/support/${d.ticketId}` : `/support/${d.ticketId}`} className="text-accent hover:underline">{t('openTicket')}</NextLink></dd></div>}
    </dl>
    {d.resolution && <Notice tone={d.status === 'rejected' ? 'danger' : 'success'} title={t('decision')}><span className="whitespace-pre-wrap">{d.resolution}</span></Notice>}
    {!admin && isOpen(d) && <div><ConfirmButton size="sm" variant="ghost" icon={<I name="undo-2" size={14}/>} label={t('withdraw')} title={t('withdraw')} body={t('withdrawBody')}
      confirmLabel={t('withdraw')} cancelLabel={t('cancel')} onConfirm={withdraw}/></div>}
  </div>;
}

// On an invoice: its disputes, and a form to open one while none is open and the time has not passed.
export function InvoiceDisputes({ d }: { d: InvoiceDetail }) {
  const t = useTranslations('Disputes');
  const format = useFormatter();
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ disputes: Dispute[]; windowDays: number }>(['billing', 'disputes', d.invoice.id], `/billing/invoices/${d.invoice.id}/disputes`);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [lineIds, setLineIds] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const inv = d.invoice;
  const list = q.data?.disputes ?? [];
  const issued = new Date(inv.issuedAt ?? inv.createdAt).getTime();
  const allowed = inv.kind !== 'topup' && ['unpaid', 'paid', 'partially_refunded'].includes(inv.status) && !list.some(isOpen)
    && Date.now() - issued < (q.data?.windowDays ?? 60) * 86_400_000;
  const money = (v: number | string) => format.number(Number(v), { style: 'currency', currency: inv.currency });
  const chosen = d.lines.filter((l) => l.id && lineIds.includes(l.id)).reduce((a, l) => a + Number(l.gross), 0);
  const refresh = () => { void client.invalidateQueries({ queryKey: ['billing'] }); void client.invalidateQueries({ queryKey: ['notifications'] }); };
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFields({});
    try {
      const attachments = await Promise.all(files.map(readFile));
      const r = await apiFetch<{ number: number }>(`/billing/invoices/${inv.id}/disputes`, { method: 'POST',
        body: { reason, lineIds, ...(amount && { amount: amount.replace(',', '.') }), message, attachments } });
      toast.success(t('opened', { number: r.number })); setOpen(false); setMessage(''); setFiles([]); refresh();
    } catch (err) { setFields((err as ApiError).fields ?? {}); toast.danger(error(err)); } finally { setBusy(false); }
  }
  if (!q.data || (!list.length && !allowed)) return null;
  return <section aria-labelledby="disputes-title" className="flex flex-col gap-3 print:hidden">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id="disputes-title" className="text-lg font-semibold">{t('section')}</h2>
      {allowed && !open && <Button variant="secondary" size="sm" onPress={() => setOpen(true)}><I name="flag" size={14}/>{t('open')}</Button>}
    </div>
    {open && <form onSubmit={submit} noValidate className="flex flex-col gap-4 rounded-2xl border border-warning/40 bg-warning/5 p-4">
      <p className="text-sm text-muted">{t('formHelp')}</p>
      <SelectInput className="max-w-md" label={t('reasonLabel')} value={reason} onChange={setReason} error={field(fields.reason)}
        options={reasons.map((r) => ({ id: r, label: t(`reason.${r}`), description: t(`reasonHelp.${r}`) }))}/>
      {d.lines.length > 1 && <fieldset className="flex flex-col gap-1"><legend className="mb-1 text-sm font-medium">{t('lines')}</legend>
        {d.lines.map((l) => l.id && <CheckboxInput key={l.id} label={<span className="flex w-full justify-between gap-3"><span>{l.description}</span><span className="tabular-nums">{money(l.gross)}</span></span>}
          isSelected={lineIds.includes(l.id)} onChange={(on) => setLineIds(on ? [...lineIds, l.id!] : lineIds.filter((x) => x !== l.id))}/>)}
        {fields.lineIds && <p className="text-xs text-danger">{field(fields.lineIds)}</p>}</fieldset>}
      <TextInput className="max-w-xs" label={t('amountLabel')} value={amount} onChange={setAmount} error={field(fields.amount)}
        placeholder={(chosen || Number(inv.total) - Number(inv.refundedTotal)).toFixed(2)} help={t('amountHelp', { max: money(Number(inv.total) - Number(inv.refundedTotal)) })}/>
      <TextInput label={t('message')} value={message} onChange={setMessage} multiline maxLength={20000} error={field(fields.message)} help={t('messageHelp')}/>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={pick} type="file" multiple accept={accept} className="sr-only" onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 3)); e.target.value = ''; }}/>
        <Button size="sm" variant="ghost" isDisabled={files.length >= 3} onPress={() => pick.current?.click()}><I name="paperclip" size={14}/>{t('attach')}</Button>
        {files.map((f, i) => <span key={i} className="inline-flex items-center gap-1 rounded-lg bg-default px-2 py-1 text-xs">{f.name}
          <button type="button" aria-label={t('removeFile', { name: f.name })} onClick={() => setFiles(files.filter((_, j) => j !== i))}><I name="x" size={12}/></button></span>)}
        {fields.attachments && <span className="text-xs text-danger">{field(fields.attachments)}</span>}
      </div>
      {inv.status === 'unpaid' && <Notice tone="default">{t('paused')}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" isPending={busy} isDisabled={!reason || !message.trim()}><I name="send" size={15}/>{t('submit')}</Button>
        <Button variant="ghost" onPress={() => setOpen(false)}>{t('cancel')}</Button>
      </div>
    </form>}
    {list.map((x) => <DisputeCard key={x.id} d={x} onChanged={refresh}/>)}
  </section>;
}

// Billing → Disputes: all of the customer's disputes.
export function MyDisputes() {
  const t = useTranslations('Disputes');
  const client = useQueryClient();
  const q = useApiQuery<{ disputes: Dispute[] }>(['billing', 'disputes'], '/billing/disputes');
  const list = q.data?.disputes ?? [];
  if (q.data && !list.length) return <Empty icon={<I name="flag" size={28}/>} title={t('none')}>{t('noneHelp')}</Empty>;
  return <div className="flex flex-col gap-3">{list.map((d) => <div key={d.id} className="flex flex-col gap-1">
    <NextLink href={`/billing/invoices/${d.invoiceId}`} className="text-xs text-accent hover:underline">{t('forInvoice', { invoice: d.invoiceNumber ?? `#${d.invoiceId.slice(0, 8)}` })}</NextLink>
    <DisputeCard d={d} onChanged={() => void client.invalidateQueries({ queryKey: ['billing'] })}/></div>)}</div>;
}

// Staff: the queue (open first, the oldest decision date first), with review and decision in place.
function Decide({ d, onDone }: { d: Dispute; onDone: () => void }) {
  const t = useTranslations('Disputes');
  const format = useFormatter();
  const { error, field } = useErrorText();
  const paid = ['paid', 'partially_refunded'].includes(d.invoiceStatus);
  const [decision, setDecision] = useState<'accept' | 'partial' | 'reject'>('accept');
  const [amount, setAmount] = useState('');
  const [remedy, setRemedy] = useState(paid ? 'balance' : 'cancel');
  const [note, setNote] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const full = decision === 'accept' && Number(d.amount) >= Number(d.invoiceTotal);
  const remedies = paid ? ['balance', 'refund'] : full ? ['cancel', 'balance'] : ['balance'];
  const effective = remedies.includes(remedy) ? remedy : remedies[0];
  async function save() {
    setBusy(true); setFields({});
    try {
      await apiFetch(`/admin/billing/disputes/${d.id}/decide`, { method: 'POST', body: { decision, note, ...(decision !== 'reject' && { remedy: effective }), ...(decision === 'partial' && { amount: amount.replace(',', '.') }) } });
      toast.success(t('decided')); onDone();
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <div className="mt-3 grid gap-3 rounded-xl border border-accent/40 bg-accent/5 p-3 sm:grid-cols-2">
    <SelectInput label={t('decisionLabel')} value={decision} onChange={(v) => setDecision(v as 'accept')} options={(['accept', 'partial', 'reject'] as const).map((k) => ({ id: k, label: t(`decide.${k}`) }))}/>
    {decision === 'partial' && <TextInput label={t('amountLabel')} value={amount} onChange={setAmount} error={field(fields.amount)} help={t('partialHelp', { max: format.number(Number(d.amount), { style: 'currency', currency: d.currency }) })}/>}
    {decision !== 'reject' && <SelectInput label={t('remedyLabel')} value={effective} onChange={setRemedy} error={field(fields.remedy)}
      options={remedies.map((r) => ({ id: r, label: t(`remedy.${r as 'balance'}`), description: t(`remedyHelp.${r as 'balance'}`) }))}/>}
    <div className="sm:col-span-2"><TextInput maxLength={2000} label={t('note')} value={note} onChange={setNote} multiline error={field(fields.note)} help={t('noteHelp')}/></div>
    {/* The decision is final (money may move), so it is read back before it is saved. */}
    <div className="sm:col-span-2"><ConfirmButton isDisabled={busy || !note.trim() || (decision === 'partial' && !amount)} variant={decision === 'reject' ? 'danger' : 'primary'}
      icon={<I name="gavel" size={15}/>} label={t('saveDecision')} title={t('confirmTitle', { number: d.number })} confirmLabel={t('saveDecision')} cancelLabel={t('cancel')}
      body={decision === 'reject' ? t('confirmReject') : t('confirmAccept', { amount: format.number(Number(decision === 'partial' ? amount.replace(',', '.') : d.amount) || 0, { style: 'currency', currency: d.currency }),
        remedy: t(`remedy.${effective as 'balance'}`) })} onConfirm={save}/></div>
  </div>;
}

export function AdminDisputes({ manage }: { manage: boolean }) {
  const t = useTranslations('Disputes');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const [status, setStatus] = useState('open');
  const [deciding, setDeciding] = useState<string>();
  const q = useApiQuery<{ disputes: Dispute[]; counts: { open: number; overdue: number; accepted: number; rejected: number } }>(['admin', 'disputes', status], `/admin/billing/disputes?status=${status}`);
  const refresh = () => { void client.invalidateQueries({ queryKey: ['admin', 'disputes'] }); void client.invalidateQueries({ queryKey: ['admin', 'billing'] }); };
  async function review(id: string) {
    try { await apiFetch(`/admin/billing/disputes/${id}/review`, { method: 'POST' }); toast.success(t('inReview')); refresh(); } catch (e) { toast.danger(error(e)); }
  }
  const c = q.data?.counts;
  const list = q.data?.disputes ?? [];
  return <div className="flex flex-col gap-4">
    {c && <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {([['open', 'warning'], ['overdue', 'danger'], ['accepted', 'success'], ['rejected', 'default']] as const).map(([k, tone]) =>
        <li key={k} className={`rounded-2xl border p-3 ${k === 'overdue' && c.overdue ? 'border-danger/40 bg-danger/5' : 'border-border'}`}>
          <p className="text-xs text-muted">{t(`kpi.${k}`)}</p><p className="text-2xl font-semibold tabular-nums"><StatusChip tone={tone}>{c[k]}</StatusChip></p></li>)}
    </ul>}
    <SelectInput className="max-w-xs" label={t('filter')} value={status} onChange={setStatus}
      options={['open', 'accepted', 'partially_accepted', 'rejected', 'withdrawn', ''].map((s) => ({ id: s, label: s ? t(`filters.${s as 'open'}`) : t('filters.all') }))}/>
    {!list.length ? <Empty icon={<I name="flag" size={28}/>} title={t('queueEmpty')}/>
      : <DataTable label={t('section')} rows={list} rowKey={(d) => d.id} minWidth={720}
        columns={[{ id: 'n', label: t('col.dispute') }, { id: 'who', label: t('col.customer') }, { id: 'amount', label: t('amount') }, { id: 'state', label: t('col.state') }, { id: 'due', label: t('decisionBy') }, { id: 'act', label: '' }]}
        cells={(d) => [<div key="n" className="flex flex-col">
            <span className="font-medium">#{d.number} · {t(`reason.${d.reason as 'other'}`)}</span>
            <NextLink href={`/admin/billing/invoices/${d.invoiceId}`} className="text-xs text-accent hover:underline">{d.invoiceNumber ?? `#${d.invoiceId.slice(0, 8)}`}</NextLink>
            {deciding === d.id && <Decide d={d} onDone={() => { setDeciding(undefined); refresh(); }}/>}</div>,
          d.email ?? '–', <span key="a" className="tabular-nums">{format.number(Number(d.amount), { style: 'currency', currency: d.currency })}</span>,
          <StatusChip key="s" tone={disputeTone(d.status)}>{t(`status.${d.status}`)}</StatusChip>,
          isOpen(d) ? <span key="d" className={d.overdue ? 'font-medium text-danger' : ''}>{format.dateTime(new Date(d.dueAt), { dateStyle: 'medium' })}</span> : '–',
          <div key="x" className="flex flex-wrap gap-1">
            {d.ticketId && <NextLink href={`/admin/support/${d.ticketId}`} className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-xs text-accent hover:underline"><I name="messages-square" size={13}/>{t('openTicket')}</NextLink>}
            {manage && d.status === 'open' && <Button size="sm" variant="ghost" onPress={() => void review(d.id)}><I name="search" size={13}/>{t('takeReview')}</Button>}
            {manage && isOpen(d) && deciding !== d.id && <Button size="sm" variant="secondary" onPress={() => setDeciding(d.id)}><I name="gavel" size={13}/>{t('decideButton')}</Button>}
          </div>]}/>}
  </div>;
}
