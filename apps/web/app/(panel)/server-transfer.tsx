"use client";
// Handing a server to another account: the owner's offer on the server page (staff move it at once), and the offers
// an account received or made (Account → Transfers).
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../components/icon';
import { ConfirmButton, Empty, Section, StatusChip, TextInput, type Tone } from '../../components/ui';
import { apiFetch, type ApiError, useErrorText } from '../../lib/api';
import { useApiQuery } from '../../lib/query';

type Transfer = { id: string; status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired'; note: string | null; createdAt: string; expiresAt: string;
  serverId: string; serverName: string; vcpu: number; memoryMb: number; diskGb: number; priceMonthly: string; currency: string;
  fromEmail: string; fromName: string | null; toEmail: string; toName: string | null };
const tone: Record<Transfer['status'], Tone> = { pending: 'accent', accepted: 'success', declined: 'danger', cancelled: 'default', expired: 'default' };

export function TransferServer({ serverId, serverName, staff, busy }: { serverId: string; serverName: string; staff: boolean; busy: boolean }) {
  const t = useTranslations('Transfers');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const format = useFormatter();
  // An offer already waiting for this server: shown instead of a second one.
  const offers = useApiQuery<{ incoming: Transfer[]; outgoing: Transfer[] }>(['transfers'], '/transfers', { enabled: !staff }).data;
  const waiting = offers?.outgoing.find((x) => x.serverId === serverId && x.status === 'pending' && Date.parse(x.expiresAt) > Date.now());
  async function withdraw(id: string) {
    try { await apiFetch(`/transfers/${id}/cancel`, { method: 'POST' }); toast.success(t('done.cancel', { name: serverName })); client.invalidateQueries({ queryKey: ['transfers'] }); }
    catch (e) { toast.danger(error(e)); }
  }
  async function send() {
    setSending(true); setFields({});
    try {
      if (staff) {
        await apiFetch(`/admin/servers/${serverId}/owner`, { method: 'PUT', body: { email } });
        toast.success(t('moved', { email }));
        client.invalidateQueries({ queryKey: ['servers'] }); client.invalidateQueries({ queryKey: ['server', serverId] });
      } else {
        await apiFetch(`/servers/${serverId}/transfer`, { method: 'POST', body: { email, ...(note.trim() && { note }) } });
        toast.success(t('offered', { email }));
        client.invalidateQueries({ queryKey: ['transfers'] });
      }
      setEmail(''); setNote('');
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setSending(false); }
  }
  const reason = fields.server ? field(fields.server) : undefined;
  return <Section title={t(staff ? 'staffTitle' : 'title')} description={t(staff ? 'staffHelp' : 'help')}>
    {waiting ? <div className="flex flex-col gap-3 rounded-xl border border-accent/40 bg-accent-soft/40 p-3 sm:flex-row sm:items-center">
      <I name="send" size={18} className="shrink-0 text-accent"/>
      <p className="flex-1 text-sm">{t('waiting', { email: waiting.toName || waiting.toEmail, date: format.dateTime(new Date(waiting.expiresAt), { dateStyle: 'medium' }) })}</p>
      <ConfirmButton size="sm" variant="secondary" label={t('withdraw')} title={t('withdrawTitle', { name: serverName })} body={t('withdrawBody', { email: waiting.toEmail })}
        confirmLabel={t('withdraw')} cancelLabel={t('cancel')} onConfirm={() => withdraw(waiting.id)}/>
    </div> : <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); }} noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput label={t('email')} type="email" value={email} onChange={setEmail} maxLength={254} spellCheck={false} error={field(fields.email)}/>
        {!staff && <TextInput label={t('note')} value={note} onChange={setNote} maxLength={300} help={t('noteHelp')}/>}
      </div>
      {reason && <p role="alert" className="flex items-start gap-1.5 text-sm text-danger"><I name="circle-alert" size={15} className="mt-0.5 shrink-0"/>{reason}</p>}
      <p className="text-xs text-muted">{t('keeps')}</p>
      <div>
        <ConfirmButton variant="secondary" icon={<I name="arrow-right-left" size={15}/>} label={t(staff ? 'move' : 'offer')} isDisabled={busy || !email.includes('@') || sending}
          title={t(staff ? 'moveTitle' : 'offerTitle', { name: serverName })} body={t(staff ? 'moveBody' : 'offerBody', { email })}
          confirmLabel={t(staff ? 'move' : 'offer')} cancelLabel={t('cancel')} onConfirm={send}/>
      </div>
    </form>}
  </Section>;
}

function Row({ x, incoming }: { x: Transfer; incoming: boolean }) {
  const t = useTranslations('Transfers');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function act(action: 'accept' | 'decline' | 'cancel') {
    setBusy(true);
    try {
      await apiFetch(`/transfers/${x.id}/${action}`, { method: 'POST' });
      toast.success(t(`done.${action}`, { name: x.serverName }));
      client.invalidateQueries({ queryKey: ['transfers'] }); client.invalidateQueries({ queryKey: ['servers'] });
    } catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  const other = incoming ? x.fromName || x.fromEmail : x.toName || x.toEmail;
  const pending = x.status === 'pending';
  const daysLeft = Math.max(0, Math.ceil((Date.parse(x.expiresAt) - Date.now()) / 86_400_000));
  return <li className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center">
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-default text-muted" aria-hidden>{incoming ? <I name="inbox" size={15}/> : <I name="send" size={15}/>}</span>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="font-medium">{pending && incoming ? <span>{x.serverName}</span> : <NextLink href={`/servers/${x.serverId}`} className="hover:underline">{x.serverName}</NextLink>}</span>
      <span className="text-xs text-muted">{[t(incoming ? 'from' : 'to', { who: other }), t('shape', { vcpu: x.vcpu, memory: Math.round(x.memoryMb / 1024), disk: x.diskGb }),
        format.number(Number(x.priceMonthly), { style: 'currency', currency: x.currency }) + t('perMonth'),
        pending ? t('until', { date: format.dateTime(new Date(x.expiresAt), { dateStyle: 'medium' }) }) : format.dateTime(new Date(x.createdAt), { dateStyle: 'medium' })].join(' · ')}</span>
      {x.note && <span className="mt-1 text-sm italic text-muted">“{x.note}”</span>}
    </span>
    <div className="flex flex-wrap items-center gap-2">
      <StatusChip tone={tone[x.status]}>{t(`status.${x.status}`)}</StatusChip>
      {pending && <StatusChip tone={daysLeft <= 2 ? 'warning' : 'default'}>{t('daysLeft', { n: daysLeft })}</StatusChip>}
      {pending && incoming && <>
        <ConfirmButton size="sm" variant="primary" icon={<I name="check" size={14}/>} label={t('accept')} title={t('acceptTitle', { name: x.serverName })} body={t('acceptBody', { price: format.number(Number(x.priceMonthly), { style: 'currency', currency: x.currency }) })}
          confirmLabel={t('accept')} cancelLabel={t('cancel')} isDisabled={busy} onConfirm={() => act('accept')}/>
        <ConfirmButton size="sm" variant="ghost" label={t('decline')} title={t('declineTitle', { name: x.serverName })} body={t('declineBody', { who: other })}
          confirmLabel={t('decline')} cancelLabel={t('cancel')} isDisabled={busy} onConfirm={() => act('decline')}/>
      </>}
      {pending && !incoming && <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => act('cancel')}>{t('withdraw')}</Button>}
    </div>
  </li>;
}

export function MyTransfers() {
  const t = useTranslations('Transfers');
  const q = useApiQuery<{ incoming: Transfer[]; outgoing: Transfer[] }>(['transfers'], '/transfers');
  const list = (rows: Transfer[], incoming: boolean) => rows.length
    ? <ul className="flex flex-col divide-y divide-separator rounded-lg border border-border">{rows.map((x) => <Row key={x.id} x={x} incoming={incoming}/>)}</ul>
    : <Empty icon={incoming ? <I name="inbox" size={28}/> : <I name="send" size={28}/>} title={t(incoming ? 'noneIn' : 'noneOut')}/>;
  if (!q.data) return <div className="h-40 animate-pulse rounded-3xl bg-default/50"/>;
  return <div className="flex flex-col gap-6">
    <Section title={t('incoming')} description={t('incomingHelp')}>{list(q.data.incoming, true)}</Section>
    <Section title={t('outgoing')} description={t('outgoingHelp')}>{list(q.data.outgoing, false)}</Section>
  </div>;
}
