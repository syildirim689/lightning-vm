"use client";
// Staff on a server's page: which host and datastore it is on, and a live move (vMotion) to another one.
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../components/icon';
import { Section, SelectInput } from '../../components/ui';
import { apiFetch, type ApiError, useErrorText } from '../../lib/api';
import { useApiQuery } from '../../lib/query';

type Placement = { host: string | null; hosts: { moref: string; name: string; inMaintenance: boolean | null; state: string | null; servers: number }[];
  datastores: { moref: string; name: string; freeBytes: number; accessible: boolean }[] };

export function ServerPlacement({ id, busy }: { id: string; busy: boolean }) {
  const t = useTranslations('Placement');
  const format = useFormatter();
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<Placement>(['admin', 'placement', id], `/admin/servers/${id}/placement`);
  const [host, setHost] = useState('');
  const [datastore, setDatastore] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  if (!q.data || q.data.hosts.length === 0) return null;
  async function move() {
    setSending(true); setFields({});
    try {
      await apiFetch(`/admin/servers/${id}/migrate`, { method: 'POST', body: { hostMoref: host, datastoreMoref: datastore } });
      toast.success(t('moving')); setHost(''); setDatastore('');
      client.invalidateQueries({ queryKey: ['servers'] }); client.invalidateQueries({ queryKey: ['admin', 'placement', id] });
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setSending(false); }
  }
  const gb = (b: number) => `${format.number(b / 1024 ** 3, { maximumFractionDigits: 0 })} GB`;
  return <Section title={t('title')} description={t('help')}>
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
      <SelectInput label={t('host')} value={host} onChange={setHost} error={field(fields.hostMoref)}
        options={[{ id: '', label: t('keep') }, ...q.data.hosts.map((h) => ({ id: h.moref, label: h.name, isDisabled: h.moref === q.data!.host || !!h.inMaintenance || h.state !== 'connected',
          description: [h.moref === q.data!.host && t('now'), t('servers', { n: h.servers }), h.inMaintenance && t('maintenance')].filter(Boolean).join(' · ') }))]}/>
      <SelectInput label={t('datastore')} value={datastore} onChange={setDatastore} error={field(fields.datastoreMoref)}
        options={[{ id: '', label: t('keep') }, ...q.data.datastores.filter((d) => d.accessible).map((d) => ({ id: d.moref, label: d.name, description: gb(d.freeBytes) }))]}/>
      <Button isPending={sending} isDisabled={busy || (!host && !datastore)} onPress={move}><I name="truck" size={15}/>{t('move')}</Button>
    </div>
  </Section>;
}
