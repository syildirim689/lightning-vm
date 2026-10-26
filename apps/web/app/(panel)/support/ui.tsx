"use client";
// Support tickets, shared by the customer pages (/support) and the staff pages (/admin/support): status and priority
// badges, the deadline, the message thread and the reply box (with attachments; staff also get internal notes and
// canned replies).
import { Button, Chip, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useFormatter, useLocale, useNow, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { I } from '../../../components/icon';
import { SelectInput, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../lib/api';
import { useMe } from '../../../lib/me';
import { useApiQuery } from '../../../lib/query';

export type Ticket = { id: string; number: number; subject: string; status: Status; priority: Priority; dueAt: string | null; firstResponseAt: string | null; createdAt: string; updatedAt: string;
  closedAt: string | null; rating: number | null; ratingComment: string | null; departmentId: string | null; departmentTr: string | null; departmentEn: string | null; serverId: string | null;
  serverName: string | null; ownerId: string; assigneeId: string | null; assigneeEmail: string | null; ownerEmail?: string; ownerName?: string; messages?: number };
export type Message = { id: string; staff: boolean; internal: boolean; body: string; createdAt: string; author: string | null; attachments: { id: string; name: string; type: string; size: number }[] };
export type Status = 'open' | 'answered' | 'customer_reply' | 'on_hold' | 'closed';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';

const statusTone: Record<Status, string> = { open: 'bg-accent/15 text-accent', customer_reply: 'bg-accent/15 text-accent', answered: 'bg-success/15 text-success', on_hold: 'bg-default text-muted', closed: 'bg-default text-muted' };
const priorityTone: Record<Priority, string> = { low: 'bg-default text-muted', normal: 'bg-default text-foreground', high: 'bg-warning/15 text-warning', urgent: 'bg-danger/15 text-danger' };

export function StatusBadge({ status }: { status: Status }) {
  const t = useTranslations('Support');
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusTone[status]}`}>{t(`status.${status}`)}</span>;
}
export function PriorityBadge({ priority }: { priority: Priority }) {
  const t = useTranslations('Support');
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${priorityTone[priority]}`}>
    {priority === 'urgent' && <I name="flame" size={12}/>}{t(`priority.${priority}`)}</span>;
}
export const departmentName = (t: Pick<Ticket, 'departmentTr' | 'departmentEn'>, locale: string) => (locale === 'tr' ? t.departmentTr : t.departmentEn) ?? '–';

// The staff deadline: time left, or how late, coloured as it gets close.
export function Deadline({ dueAt }: { dueAt: string | null }) {
  const t = useTranslations('Support');
  const now = useNow({ updateInterval: 30_000 });
  if (!dueAt) return null;
  const left = Date.parse(dueAt) - now.getTime();
  const abs = Math.abs(left), h = Math.floor(abs / 3_600_000), m = Math.floor((abs % 3_600_000) / 60_000);
  const span = h ? t('hm', { h, m }) : t('m', { m });
  const tone = left < 0 ? 'bg-danger text-danger-foreground' : left < 3_600_000 ? 'bg-warning/20 text-warning' : 'bg-default text-muted';
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums ${tone}`}>
    <I name={left < 0 ? 'alarm-clock-off' : 'alarm-clock'} size={12}/>{left < 0 ? t('late', { span }) : t('left', { span })}</span>;
}

const readFile = (f: File) => new Promise<{ name: string; type: string; data: string }>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve({ name: f.name, type: f.type || 'text/plain', data: String(r.result).split(',')[1] ?? '' });
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});
const accept = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,.log,.txt';

// The thread, oldest first; staff answers on the right, internal notes marked.
export function Thread({ messages, staffView }: { messages: Message[]; staffView: boolean }) {
  const t = useTranslations('Support');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  return <ol className="flex flex-col gap-4">
    {messages.map((m, i) => {
      const mine = staffView ? m.staff : !m.staff;
      return <motion.li key={m.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 6) * 0.03 }}
        className={`flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}>
        <div className={`max-w-[min(42rem,100%)] rounded-2xl px-4 py-3 text-sm ${m.internal ? 'border border-dashed border-warning/60 bg-warning/10' : m.staff ? 'bg-accent/10' : 'border border-border bg-surface'} ${mine ? 'rounded-br-md' : 'rounded-bl-md'}`}>
          {m.internal && <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-warning"><I name="eye-off" size={12}/>{t('internalNote')}</p>}
          <p className="whitespace-pre-line break-words">{m.body}</p>
          {m.attachments.length > 0 && <ul className="mt-2 flex flex-wrap gap-2">{m.attachments.map((a) => <li key={a.id}>
            <a href={`/api/support/attachments/${a.id}`} download className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs hover:border-accent">
              <I name={a.type.startsWith('image/') ? 'image' : a.type === 'application/pdf' ? 'file-text' : 'file'} size={13}/>{a.name}<span className="text-muted">{Math.max(1, Math.round(a.size / 1024))} KB</span></a></li>)}</ul>}
        </div>
        <span className="px-1 text-[11px] text-muted">{m.staff ? (m.author ?? t('supportTeam')) : (m.author ?? t('customer'))} · {format.relativeTime(new Date(Math.min(Date.parse(m.createdAt), now.getTime())), now)}</span>
      </motion.li>;
    })}
  </ol>;
}

// The reply box: text, up to 3 files, and for staff an internal-note switch and canned replies.
export function Composer({ ticketId, staff, closed, onSent }: { ticketId: string; staff: boolean; closed: boolean; onSent: () => void }) {
  const t = useTranslations('Support');
  const { error, field } = useErrorText();
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErr, setFieldErr] = useState<string>();
  const pick = useRef<HTMLInputElement>(null);
  const canned = useApiQuery<{ canned: { id: string; title: string; body: string }[] }>(['admin', 'support', 'canned'], staff ? '/admin/support/canned' : null).data?.canned ?? [];
  async function send() {
    setBusy(true); setFieldErr(undefined);
    try {
      await apiFetch(`/support/tickets/${ticketId}/messages`, { method: 'POST', body: { body, internal, attachments: await Promise.all(files.map(readFile)) } });
      setBody(''); setFiles([]); setInternal(false); toast.success(internal ? t('noteAdded') : t('sent')); onSent();
    } catch (e) { setFieldErr((e as ApiError).fields?.attachments); toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <div className={`flex flex-col gap-3 rounded-2xl border p-4 ${internal ? 'border-dashed border-warning/60 bg-warning/5' : 'border-border bg-surface'}`}>
    {closed && !staff && <p className="text-xs text-muted">{t('reopenHint')}</p>}
    {staff && canned.length > 0 && <SelectInput label={t('canned')} value="" onChange={(id) => { const c = canned.find((x) => x.id === id); if (c) setBody((b) => (b ? `${b}\n\n${c.body}` : c.body)); }}
      options={canned.map((c) => ({ id: c.id, label: c.title }))} placeholder={t('cannedPick')}/>}
    <TextInput multiline label={internal ? t('noteLabel') : t('replyLabel')} value={body} onChange={setBody}/>
    <AnimatePresence>{files.length > 0 && <motion.ul initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-wrap gap-2">
      {files.map((f, i) => <li key={i} className="inline-flex items-center gap-1 rounded-lg bg-default px-2 py-1 text-xs">{f.name}
        <button type="button" aria-label={t('removeFile', { name: f.name })} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="grid size-5 place-items-center rounded hover:bg-default-foreground/10"><I name="x" size={12}/></button></li>)}
    </motion.ul>}</AnimatePresence>
    {fieldErr && <p className="text-xs text-danger">{field(fieldErr)}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={pick} type="file" multiple accept={accept} className="sr-only" onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 3)); e.target.value = ''; }}/>
        <Button size="sm" variant="ghost" isDisabled={files.length >= 3} onPress={() => pick.current?.click()}><I name="paperclip" size={14}/>{t('attach')}</Button>
        {staff && <Button size="sm" variant={internal ? 'secondary' : 'ghost'} aria-pressed={internal} onPress={() => setInternal(!internal)}><I name="eye-off" size={14}/>{t('internal')}</Button>}
      </div>
      <Button isPending={busy} isDisabled={!body.trim()} onPress={send}><I name="send" size={15}/>{internal ? t('addNote') : t('send')}</Button>
    </div>
    <p className="text-[11px] text-muted">{t('filesHelp')}</p>
  </div>;
}

// The whole ticket page, for the customer or for staff (with the side panel).
export function TicketPage({ id, staff }: { id: string; staff: boolean }) {
  const t = useTranslations('Support');
  const locale = useLocale();
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const me = useMe();
  const q = useApiQuery<{ ticket: Ticket; messages: Message[]; staff: boolean }>(['support', 'ticket', id], `/support/tickets/${id}`, { refetchInterval: 15_000 });
  const refresh = () => { void client.invalidateQueries({ queryKey: ['support'] }); void client.invalidateQueries({ queryKey: ['admin', 'support'] }); };
  if (q.isError) return <p className="text-sm text-muted">{t('notFound')}</p>;
  if (!q.data) return <div className="h-64 animate-pulse rounded-3xl bg-default/50"/>;
  const { ticket: tk, messages } = q.data;
  // Staff tools (internal notes, canned replies) only on other people's tickets: on your own you write as a customer.
  const asStaff = staff && tk.ownerId !== me?.id;
  const closed = tk.status === 'closed';
  const close = async () => { await apiFetch(`/support/tickets/${id}/close`, { method: 'POST' }).then(() => toast.success(t('closedNow')), (e) => toast.danger(error(e))); refresh(); };
  return <div className="flex flex-col gap-5">
    <header className="flex flex-col gap-2">
      <p className="text-sm text-muted">#{tk.number} · {departmentName(tk, locale)}{tk.serverName && <> · <I name="server" size={12} className="inline"/> {tk.serverName}</>}</p>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight">{tk.subject}</h1>
        <div className="flex flex-wrap items-center gap-2"><StatusBadge status={tk.status}/><PriorityBadge priority={tk.priority}/>{staff && <Deadline dueAt={tk.dueAt}/>}</div>
      </div>
      <p className="text-xs text-muted">{t('opened', { when: format.dateTime(new Date(tk.createdAt), { dateStyle: 'medium', timeStyle: 'short' }) })}</p>
    </header>
    <div className={`grid gap-5 ${staff ? 'xl:grid-cols-[minmax(0,1fr)_20rem]' : ''}`}>
      <div className="flex min-w-0 flex-col gap-5">
        <Thread messages={messages} staffView={staff}/>
        {closed && !staff && <Rating ticket={tk} onDone={refresh}/>}
        <Composer ticketId={id} staff={asStaff} closed={closed} onSent={refresh}/>
        {!closed && <div><Button size="sm" variant="ghost" onPress={close}><I name="circle-check" size={14}/>{t('close')}</Button></div>}
      </div>
      {staff && <StaffPanel ticket={tk} onChange={refresh}/>}
    </div>
  </div>;
}

function Rating({ ticket, onDone }: { ticket: Ticket; onDone: () => void }) {
  const t = useTranslations('Support');
  const [stars, setStars] = useState(ticket.rating ?? 0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  if (ticket.rating) return <p className="flex items-center gap-1 text-sm text-muted">{t('rated')} {[1, 2, 3, 4, 5].map((n) => <I key={n} name="star" size={14} className={n <= ticket.rating! ? 'fill-current text-warning' : ''}/>)}</p>;
  return <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
    <p className="text-sm font-medium">{t('rateQuestion')}</p>
    <div role="radiogroup" aria-label={t('rateQuestion')} className="flex gap-1">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={t('stars', { n })}
      onClick={() => setStars(n)} className="grid size-10 place-items-center rounded-lg hover:bg-default focus-visible:outline-2 focus-visible:outline-accent">
      <I name="star" size={22} className={n <= stars ? 'fill-current text-warning' : 'text-muted'}/></button>)}</div>
    {stars > 0 && <TextInput label={t('rateComment')} value={comment} onChange={setComment} maxLength={1000}/>}
    <div><Button size="sm" isDisabled={!stars} isPending={busy} onPress={async () => { setBusy(true); await apiFetch(`/support/tickets/${ticket.id}/rating`, { method: 'POST', body: { rating: stars, comment } }).catch(() => undefined); setBusy(false); onDone(); }}>{t('rateSend')}</Button></div>
  </div>;
}

// Staff: who handles it, status and priority, and the customer at a glance.
function StaffPanel({ ticket, onChange }: { ticket: Ticket; onChange: () => void }) {
  const t = useTranslations('Support');
  const format = useFormatter();
  const { error } = useErrorText();
  const agents = useApiQuery<{ agents: { id: string; email: string; name: string }[] }>(['admin', 'support', 'agents'], '/admin/support/agents').data?.agents ?? [];
  const who = useApiQuery<{ servers: { id: string; name: string; state: string; powerState: string; price: number; currency: string }[]; tickets: { id: string; number: number; subject: string; status: Status }[] }>(
    ['admin', 'support', 'customer', ticket.ownerId], `/admin/support/customers/${ticket.ownerId}`).data;
  const change = async (patch: Record<string, unknown>) => { await apiFetch(`/admin/support/tickets/${ticket.id}`, { method: 'PATCH', body: patch }).then(() => toast.success(t('saved')), (e) => toast.danger(error(e))); onChange(); };
  return <aside className="flex flex-col gap-4">
    <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
      <SelectInput label={t('assignee')} value={ticket.assigneeId ?? ''} onChange={(v) => change({ assigneeId: v || null })}
        options={[{ id: '', label: t('unassigned') }, ...agents.map((a) => ({ id: a.id, label: a.name || a.email }))]}/>
      <SelectInput label={t('statusLabel')} value={ticket.status} onChange={(v) => change({ status: v })}
        options={(['open', 'answered', 'customer_reply', 'on_hold', 'closed'] as const).map((s) => ({ id: s, label: t(`status.${s}`) }))}/>
      <SelectInput label={t('priorityLabel')} value={ticket.priority} onChange={(v) => change({ priority: v })}
        options={(['low', 'normal', 'high', 'urgent'] as const).map((p) => ({ id: p, label: t(`priority.${p}`) }))}/>
    </section>
    <section className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 text-sm">
      <h2 className="font-semibold">{t('customer')}</h2>
      <p className="truncate text-muted">{ticket.ownerName || ticket.ownerEmail}{ticket.ownerName && <span className="block truncate text-xs">{ticket.ownerEmail}</span>}</p>
      {who && <>
        <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-muted">{t('servers')}</p>
        {who.servers.length === 0 ? <p className="text-xs text-muted">–</p> : <ul className="flex flex-col gap-1">{who.servers.map((s) => <li key={s.id}>
          <a href={`/servers/${s.id}`} className="flex items-center gap-2 text-xs hover:underline"><span aria-hidden className={`size-2 rounded-full ${s.state !== 'ready' ? 'bg-warning' : s.powerState === 'poweredOn' ? 'bg-success' : 'bg-default-foreground/30'}`}/>
            <span className="min-w-0 flex-1 truncate">{s.name}</span><span className="tabular-nums text-muted">{format.number(s.price, { style: 'currency', currency: s.currency })}</span></a></li>)}</ul>}
        {who.tickets.length > 1 && <><p className="mt-1 text-xs font-semibold uppercase tracking-wider text-muted">{t('otherTickets')}</p>
          <ul className="flex flex-col gap-1">{who.tickets.filter((x) => x.id !== ticket.id).slice(0, 5).map((x) => <li key={x.id}>
            <a href={`/admin/support/${x.id}`} className="flex items-center gap-2 text-xs hover:underline"><span className="text-muted">#{x.number}</span><span className="min-w-0 flex-1 truncate">{x.subject}</span></a></li>)}</ul></>}
      </>}
    </section>
  </aside>;
}

export const useDepartments = () => useApiQuery<{ departments: { id: string; nameTr: string; nameEn: string }[] }>(['support', 'departments'], '/support/departments').data?.departments ?? [];
export { Chip };
