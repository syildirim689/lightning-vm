"use client";
// The customer's tickets: those with an answer first, then by last change. A new ticket opens in a dialog that
// suggests a higher priority when the chosen server is in trouble.
import { Button, Modal, SearchField, toast } from '@heroui/react';
import { TicketSuggestions } from './suggestions';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import NextLink from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { useFormatter, useLocale, useNow, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { I } from '../../../components/icon';
import { Ago, Empty, PageHeader, SelectInput, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../lib/api';
import { fold } from '../../../lib/note-line';
import { useApiQuery } from '../../../lib/query';
import { firstLine } from '../../../lib/proposals';
import { departmentName, DraftBadge, PriorityBadge, StatusBadge, useDepartments, useDrafts, type Ticket } from './ui';

export default function SupportList() {
  const t = useTranslations('Support');
  const locale = useLocale();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  // /support?new=1&server=<id> opens the form (the server page links here).
  useEffect(() => { if (params.get('new')) setOpen(true); }, [params]);
  const tickets = useApiQuery<{ tickets: Ticket[] }>(['support', 'mine'], '/support/tickets', { refetchInterval: 30_000 }).data?.tickets;
  const drafts = useDrafts();
  // Answered (waiting for the customer), still open with support, or closed; and a search over subject, number and server.
  // Kept in the address so a filtered list survives going into a ticket and back, and can be shared.
  const [show, setShow] = useQueryState('show', parseAsStringLiteral(['all', 'answered', 'open', 'closed'] as const).withDefault('all').withOptions({ history: 'replace' }));
  const [q, setQ] = useQueryState('q', parseAsString.withDefault('').withOptions({ history: 'replace', throttleMs: 300 }));
  const group = (x: Ticket) => x.status === 'answered' ? 'answered' : x.status === 'closed' ? 'closed' : 'open';
  const needle = fold(q.trim().replace(/^#/, ''));
  const shown = (tickets ?? []).filter((x) => (show === 'all' || group(x) === show) && (!needle || [x.subject, String(x.number), x.serverName].some((v) => v && fold(v).includes(needle))));
  const count = (g: string) => (tickets ?? []).filter((x) => group(x) === g).length;
  return <>
    <PageHeader title={t('title')} description={t('intro')} actions={<Button onPress={() => setOpen(true)}><I name="plus" size={16}/>{t('new')}</Button>}/>
    {!tickets ? <div className="h-40 animate-pulse rounded-3xl bg-default/50"/>
      : tickets.length === 0 ? <Empty icon={<I name="life-buoy" size={28}/>} title={t('empty')}><Button className="mt-3" onPress={() => setOpen(true)}><I name="plus" size={16}/>{t('new')}</Button></Empty>
      : <div className="flex flex-col gap-3">
        {tickets.length > 1 && <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <SearchField aria-label={t('mySearch')} value={q} onChange={setQ} className="w-full md:w-72">
            <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('mySearch')}/><SearchField.ClearButton/></SearchField.Group>
          </SearchField>
          <div role="group" aria-label={t('statusFilter')} className="flex flex-wrap gap-1.5">
            {(['all', 'answered', 'open', 'closed'] as const).filter((k) => k === 'all' || count(k) || show === k).map((k) => <button key={k} type="button" aria-pressed={show === k} onClick={() => setShow(k)}
              className={`flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm transition-colors ${show === k ? 'border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border hover:border-accent'}`}>
              {k === 'answered' && <span aria-hidden className="size-2 rounded-full bg-success"/>}{t(`show.${k}`)} <span className="tabular-nums text-muted">{k === 'all' ? tickets.length : count(k)}</span></button>)}
          </div>
        </div>}
        {!shown.length ? <div role="status" className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">{t('noMatch')}
          <Button size="sm" variant="secondary" onPress={() => { setQ(''); setShow('all'); }}><I name="funnel-x" size={15}/>{t('clearFilters')}</Button></div>
        : <ul className="flex flex-col gap-3">{shown.map((x, i) => <motion.li key={x.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.03 }}>
          <NextLink href={`/support/${x.id}`} className={`flex flex-col gap-2 rounded-2xl border p-4 transition-colors hover:border-accent/60 focus-visible:outline-2 focus-visible:outline-accent sm:flex-row sm:items-center sm:gap-4 ${x.status === 'answered' ? 'border-success/40 bg-success/5' : 'border-border bg-surface'}`}>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">{x.status === 'answered' && <span aria-hidden className="size-2 shrink-0 rounded-full bg-success"/>}<span className="truncate font-medium">{x.subject}</span></span>
              <span className="block truncate text-xs text-muted">#{x.number} · {departmentName(x, locale)}{x.serverName && ` · ${x.serverName}`} · <Ago at={x.updatedAt}/></span>
            </span>
            <span className="flex shrink-0 flex-wrap items-center gap-2">{!!x.messages && <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted" title={t('messages', { n: x.messages })}>
              <I name="messages-square" size={13}/>{x.messages}<span className="sr-only"> {t('messages', { n: x.messages })}</span></span>}
              {drafts.has(x.id) && <DraftBadge/>}<PriorityBadge priority={x.priority}/><StatusBadge status={x.status}/></span>
          </NextLink>
        </motion.li>)}</ul>}
      </div>}
    {open && <NewTicket initialServer={params.get('server') ?? ''} initialSubject={params.get('subject') ?? ''} initialBody={params.get('body') ?? ''} mine={tickets ?? []} onClose={() => setOpen(false)}/>}
  </>;
}

type Srv = { id: string; name: string; state: string; powerState: string; guestReady: boolean };

function NewTicket({ initialServer, initialSubject, initialBody, mine, onClose }: { initialServer: string; initialSubject: string; initialBody: string; mine: Ticket[]; onClose: () => void }) {
  const t = useTranslations('Support');
  const locale = useLocale();
  const router = useRouter();
  const client = useQueryClient();
  const { error, field } = useErrorText();
  const deps = useDepartments();
  const servers = useApiQuery<{ servers: Srv[] }>(['servers'], '/servers').data?.servers ?? [];
  const [v, setV] = useState({ subject: initialSubject.slice(0, 160), departmentId: '', priority: initialSubject ? 'high' : 'normal', serverId: initialServer, body: initialBody.slice(0, 5000) });
  const [files, setFiles] = useState<File[]>([]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!v.departmentId && deps[0]) setV((x) => ({ ...x, departmentId: deps[0].id })); }, [deps]); // eslint-disable-line react-hooks/exhaustive-deps
  // Subject and message survive closing the dialog or the tab, until the ticket is sent.
  const draftKey = 'lvm:support-new-draft';
  useEffect(() => { if (initialSubject) return; try { const d = JSON.parse(localStorage.getItem(draftKey) ?? 'null') as { subject?: string; body?: string } | null; if (d) setV((x) => ({ ...x, subject: d.subject ?? '', body: d.body ?? '' })); } catch { /* storage blocked */ } }, []);
  useEffect(() => { try { if (v.subject.trim() || v.body.trim()) localStorage.setItem(draftKey, JSON.stringify({ subject: v.subject, body: v.body })); else localStorage.removeItem(draftKey); } catch { /* storage blocked */ } }, [v.subject, v.body]);
  const addFiles = (more: File[]) => setFiles((now) => [...now, ...more].slice(0, 3));
  const ready = v.subject.trim().length >= 3 && !!v.body.trim() && !!v.departmentId;
  const server = servers.find((s) => s.id === v.serverId);
  // A server in an error state or off: suggest a higher priority (the customer decides).
  const troubled = server && (server.state === 'error' || server.state === 'missing' || (server.state === 'ready' && server.powerState !== 'poweredOn'));
  const already = v.serverId ? mine.find((x) => x.serverId === v.serverId && x.status !== 'closed') : undefined;
  // No subject yet but a message: its first line, with the server's name in front when one is chosen, offered with one
  // click (never filled in: the subject is the customer's own words to support).
  const line = firstLine(v.body, 80);
  const subjectIdea = !v.subject.trim() && line.length >= 3 ? (server && !fold(line).includes(fold(server.name)) ? `${server.name}: ${firstLine(v.body, 78 - server.name.length)}` : line) : '';
  async function submit() {
    setBusy(true); setFields({});
    try {
      const attachments = await Promise.all(files.map((f) => new Promise<{ name: string; type: string; data: string }>((res, rej) => {
        const r = new FileReader(); r.onload = () => res({ name: f.name, type: f.type || 'text/plain', data: String(r.result).split(',')[1] ?? '' }); r.onerror = () => rej(r.error); r.readAsDataURL(f);
      })));
      const r = await apiFetch<{ id: string; number: number }>('/support/tickets', { method: 'POST', body: { ...v, serverId: v.serverId || null, attachments } });
      try { localStorage.removeItem(draftKey); } catch { /* storage blocked */ }
      toast.success(t('created', { number: r.number })); void client.invalidateQueries({ queryKey: ['support'] }); router.push(`/support/${r.id}`);
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Modal.Backdrop isOpen onOpenChange={(o) => { if (!o) onClose(); }}>
    <Modal.Container size="lg" scroll="inside">
      <Modal.Dialog className="bg-surface">
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading>{t('new')}</Modal.Heading></Modal.Header>
        {/* Ctrl/⌘ + Enter sends; a screenshot pasted anywhere in the form is attached. */}
        <Modal.Body className="flex flex-col gap-4" onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ready && !busy) { e.preventDefault(); void submit(); } }}
          onPaste={(e) => { const pasted = Array.from(e.clipboardData.files); if (pasted.length) { e.preventDefault(); addFiles(pasted); } }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectInput label={t('department')} value={v.departmentId} onChange={(x) => setV({ ...v, departmentId: x })} error={field(fields.departmentId)}
              options={deps.map((d) => ({ id: d.id, label: locale === 'tr' ? d.nameTr : d.nameEn }))}/>
            <SelectInput label={t('server')} value={v.serverId} onChange={(x) => setV({ ...v, serverId: x })} error={field(fields.serverId)}
              options={[{ id: '', label: t('noServer') }, ...servers.map((s) => ({ id: s.id, label: s.name }))]}/>
          </div>
          {already && <NextLink href={`/support/${already.id}`} className="flex items-start gap-2 rounded-xl border border-accent/40 bg-accent/5 px-3 py-2 text-sm hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-accent">
            <I name="lightbulb" size={16} className="mt-0.5 shrink-0 text-accent"/>
            <span>{t('openAlready', { number: already.number, subject: already.subject })} <span className="font-medium text-accent">{t('openAlreadyLink')}</span></span>
          </NextLink>}
          {/* Quick start: a common topic fills the subject and a message that asks for what support needs to know. */}
          {!v.subject.trim() && !v.body.trim() && <div className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-sm font-medium"><I name="sparkles" size={14} className="text-accent"/>{t('quick.title')}</p>
            <div className="flex flex-wrap gap-1.5">
              {(['ssh', 'slow', 'network', 'billing', 'feature'] as const).map((k) => <button key={k} type="button" onClick={() => setV({ ...v, subject: t(`quick.${k}.subject`), body: t(`quick.${k}.body`), priority: k === 'ssh' || k === 'network' ? 'high' : v.priority })}
                className="flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-xs font-medium transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">
                <I name={{ ssh: 'square-terminal', slow: 'gauge', network: 'wifi-off', billing: 'receipt-text', feature: 'lightbulb' }[k]} size={13}/>{t(`quick.${k}.label`)}</button>)}
            </div>
          </div>}
          <TextInput label={t('subject')} value={v.subject} onChange={(x) => setV({ ...v, subject: x })} maxLength={160} error={field(fields.subject)} placeholder={t('subjectExample')}
            suggestions={subjectIdea ? [subjectIdea] : undefined}/>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t('priorityLabel')}</p>
            <div role="radiogroup" aria-label={t('priorityLabel')} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(['low', 'normal', 'high', 'urgent'] as const).map((p) => <button key={p} type="button" role="radio" aria-checked={v.priority === p} onClick={() => setV({ ...v, priority: p })}
                className={`flex min-h-11 flex-col items-start rounded-xl border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent ${v.priority === p ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/50'}`}>
                <span className="font-medium">{t(`priority.${p}`)}</span><span className="text-[11px] text-muted">{t(`priorityHelp.${p}`)}</span></button>)}
            </div>
            {troubled && (v.priority === 'low' || v.priority === 'normal') && <button type="button" onClick={() => setV({ ...v, priority: 'high' })}
              className="flex items-center gap-2 self-start rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning hover:bg-warning/20"><I name="lightbulb" size={14}/>{t('suggestHigh', { name: server!.name })}</button>}
          </div>
          <TextInput transient maxLength={5000} multiline label={t('message')} value={v.body} onChange={(x) => setV({ ...v, body: x })} help={`${t('messageHelp')} ${t('pasteHint')}`}/>
          {/* What may already answer it: the customer's own answered tickets and the public status page, nothing else. */}
          <TicketSuggestions subject={v.subject} body={v.body}/>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={pick} type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,.log,.txt" className="sr-only"
              onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }}/>
            <Button size="sm" variant="ghost" isDisabled={files.length >= 3} onPress={() => pick.current?.click()}><I name="paperclip" size={14}/>{t('attach')}</Button>
            {files.map((f, i) => <span key={i} className="inline-flex max-w-full items-center gap-1 rounded-lg bg-default px-2 py-1 text-xs"><span className="truncate">{f.name}</span>
              <button type="button" aria-label={t('removeFile', { name: f.name })} onClick={() => setFiles(files.filter((_, j) => j !== i))}><I name="x" size={12}/></button></span>)}
          </div>
          {fields.attachments && <p className="text-xs text-danger">{field(fields.attachments)}</p>}
          <p className="text-[11px] text-muted">{t('filesHelp')}</p>
        </Modal.Body>
        <Modal.Footer className="flex justify-end gap-2">
          <Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button>
          <Button isPending={busy} isDisabled={!ready} onPress={submit}><I name="send" size={15}/>{t('submit')}</Button>
        </Modal.Footer>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}
