"use client";
// A server's CD-ROM: insert an ISO from its location's library (optionally booting from it), or eject it.
import { Button } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../components/icon';
import { CheckboxInput, Notice, Section, SelectInput, StatusChip } from '../../components/ui';
import { apiFetch } from '../../lib/api';
import { useApiAction, useApiQuery } from '../../lib/query';
import { useBytes } from './admin/catalog/iso-ui';

type Isos = { isos: { id: string; name: string; sizeBytes: number | null }[]; inserted: string | null; boot: boolean };

export function ServerIso({ id, ready }: { id: string; ready: boolean }) {
  const t = useTranslations('Servers.iso');
  const bytes = useBytes();
  const key = ['servers', id, 'isos'];
  const q = useApiQuery<Isos>(key, `/servers/${id}/isos`).data;
  const [chosen, setChosen] = useState('');
  const [boot, setBoot] = useState(true);
  const set = useApiAction((body: { isoId: string | null; boot?: boolean }) => apiFetch(`/servers/${id}/iso`, { method: 'PUT', body }),
    { invalidate: [key], success: (r) => ((r as { inserted: string | null }).inserted ? t('inserted') : t('ejected')) });
  if (!q || (!q.isos.length && !q.inserted)) return null;
  const current = q.isos.find((i) => i.id === q.inserted);
  return <Section title={t('title')} description={t('explain')}>
    {current ? <div className="flex flex-wrap items-center gap-3">
      <I name="disc-3" size={20} className="text-accent"/>
      <span className="font-medium">{current.name}</span>
      <StatusChip tone="accent">{q.boot ? t('bootsFromIso') : t('mounted')}</StatusChip>
      <Button size="sm" variant="secondary" className="ml-auto" isPending={set.isPending} isDisabled={!ready} onPress={() => set.mutate({ isoId: null })}><I name="disc" size={14}/>{t('eject')}</Button>
    </div>
      : <div className="flex flex-col gap-3">
        <SelectInput label={t('choose')} value={chosen} onChange={setChosen} options={q.isos.map((i) => ({ id: i.id, label: i.name, description: bytes(i.sizeBytes) }))}/>
        <CheckboxInput label={t('boot')} isSelected={boot} onChange={setBoot} help={t('bootHelp')}/>
        <div className="flex justify-end"><Button isPending={set.isPending} isDisabled={!chosen || !ready} onPress={() => set.mutate({ isoId: chosen, boot })}><I name="disc-3" size={16}/>{t('insert')}</Button></div>
      </div>}
    {!ready && <Notice tone="warning">{t('notReady')}</Notice>}
  </Section>;
}
