"use client";
// Personal images: "Save as an image" on a server's page, and the list of one's images (Account → Images).
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../components/icon';
import { ConfirmButton, Empty, Section, StatusChip, TextInput } from '../../components/ui';
import { apiFetch, type ApiError, useErrorText } from '../../lib/api';
import { useApiQuery } from '../../lib/query';

type Image = { id: string; name: string; family: string; minDiskGb: number; createdAt: string; sourceName: string | null; servers: number };

export function SaveAsImage({ serverId, serverName, busy }: { serverId: string; serverName: string; busy: boolean }) {
  const t = useTranslations('Images');
  const format = useFormatter();
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const mine = useApiQuery<{ images: Image[]; max: number }>(['images', 'mine'], '/images/mine').data;
  const [name, setName] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const full = !!mine && mine.images.length >= mine.max;
  async function save() {
    setSending(true); setFields({});
    try {
      await apiFetch(`/servers/${serverId}/image`, { method: 'POST', body: { name: name || `${serverName} ${format.dateTime(new Date(), { dateStyle: 'short' })}` } });
      toast.success(t('saving')); setName('');
      client.invalidateQueries({ queryKey: ['servers'] }); client.invalidateQueries({ queryKey: ['tasks'] });
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setSending(false); }
  }
  return <Section title={t('title')} description={t('help')} actions={mine && <StatusChip tone={full ? 'warning' : 'default'}>{t('count', { n: mine.images.length, max: mine.max })}</StatusChip>}>
    <div className="flex flex-wrap items-end gap-3">
      <TextInput className="min-w-56 flex-1" label={t('name')} value={name} onChange={setName} maxLength={80} placeholder={serverName} error={field(fields.name)}/>
      <Button variant="secondary" isPending={sending} isDisabled={busy || full} onPress={save}><I name="image-plus" size={15}/>{t('save')}</Button>
    </div>
    {full && <p className="mt-2 text-xs text-muted">{t('full')}</p>}
  </Section>;
}

export function MyImages() {
  const t = useTranslations('Images');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ images: Image[]; max: number }>(['images', 'mine'], '/images/mine');
  async function remove(id: string) {
    try { await apiFetch(`/images/${id}`, { method: 'DELETE' }); toast.success(t('removed')); client.invalidateQueries({ queryKey: ['images'] }); client.invalidateQueries({ queryKey: ['catalog'] }); }
    catch (e) { toast.danger(error(e)); }
  }
  const list = q.data?.images ?? [];
  return <Section title={t('mine')} description={t('mineHelp')}>
    {q.data && !list.length ? <Empty icon={<I name="image" size={28}/>} title={t('none')}/>
      : <ul className="flex flex-col divide-y divide-separator rounded-lg border border-border">{list.map((i) => <li key={i.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-default text-muted" aria-hidden><I name="image" size={15}/></span>
        <span className="flex min-w-0 flex-1 flex-col"><span className="font-medium">{i.name}</span>
          <span className="text-xs text-muted">{[i.sourceName && t('from', { name: i.sourceName }), format.dateTime(new Date(i.createdAt), { dateStyle: 'medium' }), `≥ ${i.minDiskGb} GB`].filter(Boolean).join(' · ')}</span></span>
        <StatusChip tone={i.servers ? 'accent' : 'default'}>{t('servers', { n: i.servers })}</StatusChip>
        <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={t('remove')} title={t('removeTitle')} body={t('removeBody')}
          confirmLabel={t('remove')} cancelLabel={t('cancel')} isDisabled={i.servers > 0} onConfirm={() => remove(i.id)}/>
      </li>)}</ul>}
  </Section>;
}
