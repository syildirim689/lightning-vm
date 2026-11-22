"use client";
// Canned replies for the support team: kept here, picked in a ticket's reply box, where {name}, {ticket} and
// {server} become the customer's name, the ticket number and its server (fillCanned). Each can be edited, found
// by its title or text, and is previewed with sample values while it is written.
import { Button, Modal, SearchField, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../../components/icon';
import { ConfirmButton, Empty, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { fillCanned } from '../../../../lib/canned';
import { fold } from '../../../../lib/note-line';
import { useApiQuery } from '../../../../lib/query';
import { firstLine, uniqueName } from '../../../../lib/proposals';
import { useProposal } from '../../../../lib/use-proposal';

type Canned = { id: string; title: string; body: string };
const vars = ['{name}', '{ticket}', '{server}'];

export default function CannedReplies() {
  const t = useTranslations('Support');
  const { error } = useErrorText();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ title: '', body: '' });
  const [editing, setEditing] = useState<Canned | null>(null);
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useApiQuery<{ canned: Canned[] }>(['admin', 'support', 'canned'], open ? '/admin/support/canned' : null).data?.canned;
  const refresh = () => client.invalidateQueries({ queryKey: ['admin', 'support', 'canned'] });
  // A new answer is titled by its first line until a title is typed (staff only see these).
  const { proposed, again } = useProposal(editing ? undefined : uniqueName(firstLine(v.body, 80), (list ?? []).map((c) => c.title), { max: 80 }), v.title, (title) => setV((x) => ({ ...x, title })));
  const reset = () => { setV({ title: '', body: '' }); setEditing(null); again(); };
  async function save() {
    setBusy(true);
    try {
      await apiFetch(editing ? `/admin/support/canned/${editing.id}` : '/admin/support/canned', { method: editing ? 'PUT' : 'POST', body: v });
      reset(); toast.success(t('cannedSaved')); await refresh();
    } catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  async function remove(c: Canned) {
    try { await apiFetch(`/admin/support/canned/${c.id}`, { method: 'DELETE' }); toast.success(t('cannedRemoved')); if (editing?.id === c.id) reset(); }
    catch (e) { toast.danger(error(e)); }
    await refresh();
  }
  const needle = fold(find.trim());
  const shown = (list ?? []).filter((c) => !needle || fold(`${c.title} ${c.body}`).includes(needle));
  const sample = fillCanned(v.body, { name: t('cannedSample.name'), ticket: '#1042', server: 'web-1' });
  return <>
    <Button variant="secondary" onPress={() => setOpen(true)}><I name="message-square-text" size={16}/>{t('cannedManage')}</Button>
    <Modal.Backdrop isOpen={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog className="bg-surface">
          <Modal.CloseTrigger/>
          <Modal.Header><Modal.Heading>{t('cannedManage')}{list && list.length > 0 && <span className="ml-2 rounded-full bg-default px-2 align-middle text-xs tabular-nums text-muted">{list.length}</span>}</Modal.Heading></Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            {list && list.length > 5 && <SearchField aria-label={t('cannedFind')} value={find} onChange={setFind}>
              <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('cannedFind')}/><SearchField.ClearButton/></SearchField.Group>
            </SearchField>}
            {!list ? <div className="h-24 animate-pulse rounded-2xl bg-default/50"/>
              : list.length === 0 ? <Empty icon={<I name="message-square-text" size={24}/>} title={t('cannedEmpty')}/>
              : shown.length === 0 ? <p role="status" className="rounded-xl border border-dashed border-border py-6 text-center text-sm text-muted">{t('cannedNoMatch')}</p>
              : <ul className="flex flex-col gap-2">{shown.map((c) => <li key={c.id} className={`flex items-start gap-2 rounded-xl border p-3 ${editing?.id === c.id ? 'border-accent bg-accent-soft/30' : 'border-border'}`}>
                  <span className="min-w-0 flex-1"><span className="block font-medium">{c.title}</span><span className="line-clamp-2 whitespace-pre-line text-xs text-muted">{c.body}</span></span>
                  <Button isIconOnly size="sm" variant="ghost" aria-label={t('cannedEdit', { title: c.title })} onPress={() => { setEditing(c); setV({ title: c.title, body: c.body }); }}><I name="pencil" size={14}/></Button>
                  <ConfirmButton size="sm" variant="ghost" label={<><I name="trash-2" size={14}/><span className="sr-only">{t('cannedRemove', { title: c.title })}</span></>}
                    title={t('cannedRemove', { title: c.title })} body={t('cannedRemoveBody')} confirmLabel={t('cannedRemoveYes')} cancelLabel={t('cancel')} onConfirm={() => remove(c)}/>
                </li>)}</ul>}
            <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-3">
              {editing && <p className="flex items-center gap-2 text-sm font-medium text-accent"><I name="pencil" size={14}/>{t('cannedEditing', { title: editing.title })}</p>}
              <TextInput label={t('cannedTitle')} value={v.title} onChange={(x) => setV({ ...v, title: x })} maxLength={80} proposed={proposed}/>
              <TextInput multiline label={t('cannedBody')} value={v.body} onChange={(x) => setV({ ...v, body: x })} help={t('cannedVars', { a: '{name}', b: '{ticket}', c: '{server}' })}/>
              <div role="group" aria-label={t('cannedInsert')} className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted">{t('cannedInsert')}:</span>
                {vars.map((x) => <button key={x} type="button" onClick={() => setV((s) => ({ ...s, body: s.body + (s.body && !/\s$/.test(s.body) ? ' ' : '') + x }))}
                  className="rounded-md border border-border px-2 py-1 font-mono hover:border-accent focus-visible:outline-2 focus-visible:outline-accent">{x}</button>)}
              </div>
              {/\{(name|ticket|server)\}/.test(v.body) && <div className="rounded-lg bg-default/60 p-3 text-sm">
                <p className="mb-1 text-xs font-medium text-muted">{t('cannedPreview')}</p>
                <p className="whitespace-pre-line">{sample}</p>
              </div>}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" isPending={busy} isDisabled={!v.title.trim() || !v.body.trim()} onPress={save}><I name={editing ? 'check' : 'plus'} size={14}/>{editing ? t('cannedUpdate') : t('cannedAdd')}</Button>
                {editing && <Button size="sm" variant="ghost" onPress={reset}>{t('cancel')}</Button>}
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </>;
}
