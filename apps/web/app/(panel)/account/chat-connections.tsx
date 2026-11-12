"use client";
// The user's messaging apps (the "chat" notification channel): connect Telegram, WhatsApp, Slack, Discord,
// Teams... A connection is kept only after its first message arrived; each can be paused, tested or removed.
import { Button, Modal, Switch, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { AppBadge } from '../../../components/chat-app-badge';
import { I } from '../../../components/icon';
import { ConfirmButton, Notice, Section, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../lib/api';
import { useApiQuery } from '../../../lib/query';

type Field = { key: string; secret?: boolean; optional?: boolean; placeholder?: string };
type App = { id: string; name: string; website: string; docs: string; fields: Field[]; needs: string | null };
type Conn = { id: string; app: string; label: string; hint: string; enabled: boolean; lastSentAt: string | null; lastError: string | null };
type Doc = { apps: App[]; connections: Conn[]; telegramBot: string | null; phone: string | null; max: number };

export default function ChatConnections() {
  const t = useTranslations('Chat');
  const { error } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<Doc>(['chat'], '/chat');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  if (!q.data) return null;
  const { apps, connections, max } = q.data;
  if (!apps.length && !connections.length) return null;
  const name = (app: string) => apps.find((a) => a.id === app)?.name ?? app;
  const refresh = () => { void client.invalidateQueries({ queryKey: ['chat'] }); void client.invalidateQueries({ queryKey: ['notification-prefs'] }); };

  async function act(id: string, f: () => Promise<unknown>, ok?: string) {
    setBusy(id);
    try { await f(); if (ok) toast.success(ok); } catch (e) { toast.danger(error(e)); } finally { setBusy(undefined); refresh(); }
  }

  return <Section title={t('title')} description={t('intro')}
    actions={apps.length > 0 && connections.length < max ? <Button size="sm" onPress={() => setOpen(true)}><I name="plus" size={15}/>{t('connect')}</Button> : undefined}>
    {connections.length === 0
      ? <button type="button" onClick={() => setOpen(true)} className="flex w-full flex-col items-center gap-3 rounded-xl border border-dashed border-border p-6 text-center transition-colors hover:border-accent hover:bg-accent/5">
          <span className="flex -space-x-2">{apps.slice(0, 6).map((a) => <AppBadge key={a.id} app={a.id} size={32}/>)}</span>
          <span className="font-medium">{t('emptyTitle')}</span>
          <span className="max-w-md text-sm text-muted">{t('emptyHelp', { apps: apps.map((a) => a.name).join(', ') })}</span>
        </button>
      : <ul className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {connections.map((c) => <li key={c.id} className="flex flex-col gap-3 rounded-xl border border-border p-4">
            <div className="flex items-start gap-3">
              <AppBadge app={c.app}/>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{c.label}</p>
                <p className="truncate text-xs text-muted">{name(c.app)}{c.hint && ` · ${c.hint}`}</p>
              </div>
              <Switch size="sm" isSelected={c.enabled} isDisabled={busy === c.id}
                onChange={(on) => act(c.id, () => apiFetch(`/chat/connections/${c.id}`, { method: 'PATCH', body: { enabled: on } }))}>
                <Switch.Content><Switch.Control><Switch.Thumb/></Switch.Control><span className="sr-only">{t('enabled', { name: c.label })}</span></Switch.Content>
              </Switch>
            </div>
            {c.lastError ? <p className="flex items-center gap-1 text-xs text-danger"><I name="triangle-alert" size={13}/>{error({ code: c.lastError } as ApiError)}</p>
              : <p className="text-xs text-muted">{c.lastSentAt ? t('lastSent', { at: new Date(c.lastSentAt) }) : t('neverSent')}</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" isPending={busy === c.id} isDisabled={!c.enabled}
                onPress={() => act(c.id, () => apiFetch(`/chat/connections/${c.id}/test`, { method: 'POST' }), t('testSent', { name: c.label }))}><I name="send" size={14}/>{t('test')}</Button>
              <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={t('remove')} title={t('removeTitle', { name: c.label })} body={t('removeBody')}
                confirmLabel={t('remove')} cancelLabel={t('cancel')} onConfirm={() => act(c.id, () => apiFetch(`/chat/connections/${c.id}`, { method: 'DELETE' }), t('removed'))}/>
            </div>
          </li>)}
        </ul>}
    <ConnectDialog open={open} onOpenChange={setOpen} doc={q.data} onDone={() => { setOpen(false); refresh(); }}/>
  </Section>;
}

function ConnectDialog({ open, onOpenChange, doc, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; doc: Doc; onDone: () => void }) {
  const t = useTranslations('Chat');
  const { error, field } = useErrorText();
  const [app, setApp] = useState<App | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<{ text: string; detail?: string }>();
  const [busy, setBusy] = useState(false);
  const [tg, setTg] = useState<{ code: string; url: string } | null>(null);
  const reset = (a: App | null) => { setApp(a); setValues({}); setLabel(''); setFields({}); setProblem(undefined); setTg(null); };
  const fieldLabel = (k: string) => (t.has(`field.${k}` as 'field.url') ? t(`field.${k}` as 'field.url') : k);

  async function run(f: () => Promise<unknown>) {
    setBusy(true); setProblem(undefined); setFields({});
    try { await f(); toast.success(t('connected', { name: app!.name })); reset(null); onDone(); }
    catch (e) { const x = e as ApiError & { detail?: string }; setFields(x.fields ?? {}); setProblem({ text: error(x), detail: x.detail }); }
    finally { setBusy(false); }
  }
  async function telegramLink() {
    setBusy(true); setProblem(undefined);
    try {
      const r = await apiFetch<{ code: string; url: string }>('/chat/telegram/link', { method: 'POST' });
      setTg(r); window.open(r.url, '_blank', 'noopener');
    } catch (e) { setProblem({ text: error(e) }); } finally { setBusy(false); }
  }

  return <Modal.Backdrop isOpen={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(null); }}>
    <Modal.Container>
      <Modal.Dialog className="w-[36rem] max-w-[calc(100vw-1.5rem)]">
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading className="flex items-center gap-3">{app && <AppBadge app={app.id} size={30}/>}{app ? t('connectTo', { name: app.name }) : t('pick')}</Modal.Heading></Modal.Header>
        <Modal.Body className="flex flex-col gap-4">
          {!app ? <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {doc.apps.map((a) => <li key={a.id}><button type="button" onClick={() => reset(a)}
                className="flex w-full items-center gap-2 rounded-xl border border-border p-3 text-left text-sm font-medium transition-colors hover:border-accent hover:bg-accent/5 focus-visible:outline-2 focus-visible:outline-accent">
                <AppBadge app={a.id} size={28}/><span className="min-w-0 truncate">{a.name}</span></button></li>)}
            </ul>
            : <>
              <p className="text-sm text-muted">{t(`help.${app.id}` as 'help.slack')}</p>
              {app.id === 'telegram' ? <div className="flex flex-col gap-3">
                  <ol className="list-decimal space-y-1 pl-5 text-sm">
                    <li>{t('telegramStep1', { bot: `@${doc.telegramBot}` })}</li><li>{t('telegramStep2')}</li><li>{t('telegramStep3')}</li>
                  </ol>
                  {tg ? <div className="flex flex-wrap gap-2">
                      <a href={tg.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">{t('telegramOpenAgain')}<I name="external-link" size={13}/></a>
                    </div>
                    : <div><Button variant="secondary" isPending={busy} onPress={telegramLink}><I name="send" size={15}/>{t('telegramOpen')}</Button></div>}
                </div>
              : app.id === 'whatsapp' ? (doc.phone ? <Notice tone="default" title={t('whatsappTo', { phone: doc.phone })}>{t('whatsappHelp')}</Notice>
                  : <Notice tone="warning" title={t('needPhone')}>{t('needPhoneHelp')}</Notice>)
              : <div className="grid gap-3">
                  {app.fields.map((f) => <TextInput key={f.key} label={`${fieldLabel(f.key)}${f.optional ? ` (${t('optional')})` : ''}`} type={f.secret ? 'password' : 'text'}
                    value={values[f.key] ?? ''} onChange={(v) => setValues({ ...values, [f.key]: v })} placeholder={f.placeholder} spellCheck={false} autoComplete="off"
                    error={field(fields[`fields.${f.key}`])} help={t.has(`fieldHelp.${f.key}` as 'fieldHelp.secret') ? t(`fieldHelp.${f.key}` as 'fieldHelp.secret') : undefined}/>)}
                </div>}
              {app.id !== 'telegram' || tg ? <TextInput label={`${t('label')} (${t('optional')})`} value={label} onChange={setLabel} maxLength={60} placeholder={app.name}/> : null}
              {app.docs && <a href={app.docs} target="_blank" rel="noreferrer noopener" className="inline-flex w-fit items-center gap-1 text-sm text-accent hover:underline">{t('docs')}<I name="external-link" size={13}/></a>}
              {problem && <Notice tone="danger" title={problem.text}>{problem.detail && <code className="break-all text-xs">{problem.detail}</code>}</Notice>}
            </>}
        </Modal.Body>
        {app && <Modal.Footer className="flex flex-wrap justify-between gap-2">
          <Button variant="ghost" onPress={() => reset(null)}><I name="arrow-left" size={15}/>{t('back')}</Button>
          {app.id === 'telegram'
            ? <Button isPending={busy} isDisabled={!tg} onPress={() => run(() => apiFetch('/chat/telegram/verify', { method: 'POST', body: { code: tg!.code, label } }))}><I name="check" size={15}/>{t('telegramVerify')}</Button>
            : <Button isPending={busy} isDisabled={app.id === 'whatsapp' && !doc.phone}
                onPress={() => run(() => apiFetch('/chat/connections', { method: 'POST', body: { app: app.id, label, fields: values } }))}><I name="plug" size={15}/>{t('connectAndTest')}</Button>}
        </Modal.Footer>}
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}
