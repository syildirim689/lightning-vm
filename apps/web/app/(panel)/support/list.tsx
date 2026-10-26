"use client";
// The customer's tickets: those with an answer first, then by last change. A new ticket opens in a dialog that
// suggests a higher priority when the chosen server is in trouble.
import { Button, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import NextLink from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useLocale, useNow, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { I } from '../../../components/icon';
import { Empty, PageHeader, SelectInput, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../lib/api';
import { useApiQuery } from '../../../lib/query';
import { departmentName, PriorityBadge, StatusBadge, useDepartments, type Ticket } from './ui';

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
  return <>
    <PageHeader title={t('title')} description={t('intro')} actions={<Button onPress={() => setOpen(true)}><I name="plus" size={16}/>{t('new')}</Button>}/>
    {!tickets ? <div className="h-40 animate-pulse rounded-3xl bg-default/50"/>
      : tickets.length === 0 ? <Empty icon={<I name="life-buoy" size={28}/>} title={t('empty')}><Button className="mt-3" onPress={() => setOpen(true)}><I name="plus" size={16}/>{t('new')}</Button></Empty>
      : <ul className="flex flex-col gap-3">{tickets.map((x, i) => <motion.li key={x.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.03 }}>
          <NextLink href={`/support/${x.id}`} className={`flex flex-col gap-2 rounded-2xl border p-4 transition-colors hover:border-accent/60 focus-visible:outline-2 focus-visible:outline-accent sm:flex-row sm:items-center sm:gap-4 ${x.status === 'answered' ? 'border-success/40 bg-success/5' : 'border-border bg-surface'}`}>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">{x.status === 'answered' && <span aria-hidden className="size-2 shrink-0 rounded-full bg-success"/>}<span className="truncate font-medium">{x.subject}</span></span>
              <span className="block truncate text-xs text-muted">#{x.number} · {departmentName(x, locale)}{x.serverName && ` · ${x.serverName}`} · {format.relativeTime(new Date(Math.min(Date.parse(x.updatedAt), now.getTime())), now)}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2"><PriorityBadge priority={x.priority}/><StatusBadge status={x.status}/></span>
          </NextLink>
        </motion.li>)}</ul>}
    {open && <NewTicket initialServer={params.get('server') ?? ''} onClose={() => setOpen(false)}/>}
  </>;
}

type Srv = { id: string; name: string; state: string; powerState: string; guestReady: boolean };

function NewTicket({ initialServer, onClose }: { initialServer: string; onClose: () => void }) {
  const t = useTranslations('Support');
  const locale = useLocale();
  const router = useRouter();
  const client = useQueryClient();
  const { error, field } = useErrorText();
  const deps = useDepartments();
  const servers = useApiQuery<{ servers: Srv[] }>(['servers'], '/servers').data?.servers ?? [];
  const [v, setV] = useState({ subject: '', departmentId: '', priority: 'normal', serverId: initialServer, body: '' });
  const [files, setFiles] = useState<File[]>([]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!v.departmentId && deps[0]) setV((x) => ({ ...x, departmentId: deps[0].id })); }, [deps]); // eslint-disable-line react-hooks/exhaustive-deps
  const server = servers.find((s) => s.id === v.serverId);
  // A server in an error state or off: suggest a higher priority (the customer decides).
  const troubled = server && (server.state === 'error' || server.state === 'missing' || (server.state === 'ready' && server.powerState !== 'poweredOn'));
  async function submit() {
    setBusy(true); setFields({});
    try {
      const attachments = await Promise.all(files.map((f) => new Promise<{ name: string; type: string; data: string }>((res, rej) => {
        const r = new FileReader(); r.onload = () => res({ name: f.name, type: f.type || 'text/plain', data: String(r.result).split(',')[1] ?? '' }); r.onerror = () => rej(r.error); r.readAsDataURL(f);
      })));
      const r = await apiFetch<{ id: string; number: number }>('/support/tickets', { method: 'POST', body: { ...v, serverId: v.serverId || null, attachments } });
      toast.success(t('created', { number: r.number })); void client.invalidateQueries({ queryKey: ['support'] }); router.push(`/support/${r.id}`);
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Modal.Backdrop isOpen onOpenChange={(o) => { if (!o) onClose(); }}>
    <Modal.Container size="lg" scroll="inside">
      <Modal.Dialog className="bg-surface">
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading>{t('new')}</Modal.Heading></Modal.Header>
        <Modal.Body className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectInput label={t('department')} value={v.departmentId} onChange={(x) => setV({ ...v, departmentId: x })} error={field(fields.departmentId)}
              options={deps.map((d) => ({ id: d.id, label: locale === 'tr' ? d.nameTr : d.nameEn }))}/>
            <SelectInput label={t('server')} value={v.serverId} onChange={(x) => setV({ ...v, serverId: x })} error={field(fields.serverId)}
              options={[{ id: '', label: t('noServer') }, ...servers.map((s) => ({ id: s.id, label: s.name }))]}/>
          </div>
          <TextInput label={t('subject')} value={v.subject} onChange={(x) => setV({ ...v, subject: x })} maxLength={160} error={field(fields.subject)} placeholder={t('subjectExample')}/>
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
          <TextInput multiline label={t('message')} value={v.body} onChange={(x) => setV({ ...v, body: x })} help={t('messageHelp')}/>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={pick} type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,.log,.txt" className="sr-only"
              onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 3)); e.target.value = ''; }}/>
            <Button size="sm" variant="ghost" isDisabled={files.length >= 3} onPress={() => pick.current?.click()}><I name="paperclip" size={14}/>{t('attach')}</Button>
            {files.map((f, i) => <span key={i} className="inline-flex items-center gap-1 rounded-lg bg-default px-2 py-1 text-xs">{f.name}
              <button type="button" aria-label={t('removeFile', { name: f.name })} onClick={() => setFiles(files.filter((_, j) => j !== i))}><I name="x" size={12}/></button></span>)}
          </div>
          {fields.attachments && <p className="text-xs text-danger">{field(fields.attachments)}</p>}
          <p className="text-[11px] text-muted">{t('filesHelp')}</p>
        </Modal.Body>
        <Modal.Footer className="flex justify-end gap-2">
          <Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button>
          <Button isPending={busy} isDisabled={v.subject.trim().length < 3 || !v.body.trim() || !v.departmentId} onPress={submit}><I name="send" size={15}/>{t('submit')}</Button>
        </Modal.Footer>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}
