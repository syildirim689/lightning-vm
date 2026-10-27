"use client";
// Canned replies for the support team: kept here, picked in a ticket's reply box, where {name}, {ticket} and
// {server} become the customer's name, the ticket number and its server (fillCanned).
import { Button, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../../components/icon';
import { Empty, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Canned = { id: string; title: string; body: string };

export default function CannedReplies() {
  const t = useTranslations('Support');
  const { error } = useErrorText();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ title: '', body: '' });
  const [busy, setBusy] = useState(false);
  const list = useApiQuery<{ canned: Canned[] }>(['admin', 'support', 'canned'], open ? '/admin/support/canned' : null).data?.canned;
  const refresh = () => client.invalidateQueries({ queryKey: ['admin', 'support', 'canned'] });
  async function add() {
    setBusy(true);
    try { await apiFetch('/admin/support/canned', { method: 'POST', body: v }); setV({ title: '', body: '' }); toast.success(t('cannedSaved')); await refresh(); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  const remove = async (id: string) => { await apiFetch(`/admin/support/canned/${id}`, { method: 'DELETE' }).catch((e) => toast.danger(error(e))); await refresh(); };
  return <>
    <Button variant="secondary" onPress={() => setOpen(true)}><I name="message-square-text" size={16}/>{t('cannedManage')}</Button>
    <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog className="bg-surface">
          <Modal.CloseTrigger/>
          <Modal.Header><Modal.Heading>{t('cannedManage')}</Modal.Heading></Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            {!list ? <div className="h-24 animate-pulse rounded-2xl bg-default/50"/>
              : list.length === 0 ? <Empty icon={<I name="message-square-text" size={24}/>} title={t('cannedEmpty')}/>
              : <ul className="flex flex-col gap-2">{list.map((c) => <li key={c.id} className="flex items-start gap-3 rounded-xl border border-border p-3">
                  <span className="min-w-0 flex-1"><span className="block font-medium">{c.title}</span><span className="line-clamp-2 whitespace-pre-line text-xs text-muted">{c.body}</span></span>
                  <Button isIconOnly size="sm" variant="ghost" aria-label={t('cannedRemove', { title: c.title })} onPress={() => remove(c.id)}><I name="trash-2" size={14}/></Button>
                </li>)}</ul>}
            <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-3">
              <TextInput label={t('cannedTitle')} value={v.title} onChange={(x) => setV({ ...v, title: x })} maxLength={80}/>
              <TextInput multiline label={t('cannedBody')} value={v.body} onChange={(x) => setV({ ...v, body: x })} help={t('cannedVars', { a: '{name}', b: '{ticket}', c: '{server}' })}/>
              <div><Button size="sm" isPending={busy} isDisabled={!v.title.trim() || !v.body.trim()} onPress={add}><I name="plus" size={14}/>{t('cannedAdd')}</Button></div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </>;
}
