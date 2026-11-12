"use client";
import { Button, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { I } from '../../../../components/icon';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useApiAction, useApiQuery } from '../../../../lib/query';
import { ButtonLink, DataTable, Empty, Mono, PageHeader, Stat, StatusChip } from '../../../../components/ui';
import ConnectionForm, { type Prefill } from './connection-form';
import Discovery from './discovery';

export type Connection = { id: string; name: string; kind: string; host: string; port: number; tlsMode: string; writeApi: string; status: string;
  lastErrorCode: string | null; lastDiscoveredAt: string | null; hosts: number; vms: number; product: { fullName: string }; operations: Record<string, boolean>; warnings: string[];
  apiVersion: string | null; customization: 'auto' | 'cloudinit' | 'guestinfo'; compat: Compat | null };
export type Compat = { apiVersion: string; customization: 'cloudinit' | 'guestinfo' | 'none'; clone: boolean; consoleUrl: boolean; support: 'supported' | 'end-of-support' | 'legacy' };
// The versions an admin may pin; the API accepts the same list.
export const apiVersions = ['9.0.0.0', '8.0.3.0', '8.0.2.0', '8.0.1.0', '8.0.0.1', '7.0.3.0', '7.0.2.0', '7.0.1.0', '7.0.0.0', '6.7.3', '6.7.2', '6.7.1', '6.7', '6.5', '6.0'];
export const versionLabel = (v: string) => ({ '9.0.0.0': 'vSphere 9.0', '8.0.3.0': 'vSphere 8.0 U3', '8.0.2.0': 'vSphere 8.0 U2', '8.0.1.0': 'vSphere 8.0 U1', '8.0.0.1': 'vSphere 8.0',
  '7.0.3.0': 'vSphere 7.0 U3', '7.0.2.0': 'vSphere 7.0 U2', '7.0.1.0': 'vSphere 7.0 U1', '7.0.0.0': 'vSphere 7.0', '6.7.3': 'vSphere 6.7 U3', '6.7.2': 'vSphere 6.7 U2',
  '6.7.1': 'vSphere 6.7 U1', '6.7': 'vSphere 6.7', '6.5': 'vSphere 6.5', '6.0': 'vSphere 6.0' } as Record<string, string>)[v] ?? v;

export default function Connections({ eyebrow, title, intro }: { eyebrow: string; title: string; intro: string }) {
  const t = useTranslations('Vmware');
  const { error } = useErrorText();
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  // Set when the form opens from a scan result; the form starts filled in from it.
  const [prefill, setPrefill] = useState<Prefill>();
  const format = useFormatter();
  const list = useApiQuery<{ connections: Connection[] }>(['vmware', 'connections'], '/admin/vmware/connections').data?.connections;
  const discover = useApiAction((id: string) => apiFetch(`/admin/vmware/connections/${id}/discover`, { method: 'POST' }), { invalidate: [['vmware']], success: t('refreshed') });
  const busy = discover.isPending ? discover.variables : null;
  const failing = list?.filter((c) => c.status !== 'ok').length ?? 0;
  // Inventory older than a day is probably stale (discovery normally runs on its own).
  const stale = (c: Connection) => !c.lastDiscoveredAt || Date.now() - Date.parse(c.lastDiscoveredAt) > 86_400_000;

  return <>
    <PageHeader eyebrow={eyebrow} title={title} description={intro}
      actions={<div className="flex flex-wrap gap-2">
        <ButtonLink href="#discovery" variant="secondary"><I name="radar" size={16}/>{t('scan.find')}</ButtonLink>
        <Button onPress={() => { setPrefill(undefined); setAdding(true); }}><I name="plus" size={16}/>{t('add')}</Button>
      </div>}/>
    {!list ? <p role="status" className="text-sm text-muted">{t('loading')}</p>
      : list.length === 0 ? <Empty icon={<I name="cable" size={28}/>} title={t('empty')}><p className="text-sm text-muted">{t('scan.emptyConnections')}</p></Empty>
      : <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={t('sum.connections')} value={list.length} icon={<I name="cable" size={18}/>}/>
          <Stat label={t('sum.hosts')} value={list.reduce((a, c) => a + c.hosts, 0)} icon={<I name="server" size={18}/>}/>
          <Stat label={t('sum.vms')} value={list.reduce((a, c) => a + c.vms, 0)} icon={<I name="monitor" size={18}/>}/>
          <Stat label={t('sum.failing')} value={failing} tone={failing ? 'danger' : 'success'} icon={<I name={failing ? 'triangle-alert' : 'circle-check'} size={18}/>}
            hint={failing ? t('sum.failingHint') : t('sum.allOk')}/>
        </div>
        <DataTable label={t('title')} rows={list} rowKey={(c) => c.id} minWidth={900}
          columns={[{ id: 'name', label: t('col.name') }, { id: 'kind', label: t('col.kind') }, { id: 'endpoint', label: t('col.endpoint') }, { id: 'status', label: t('col.status') },
            { id: 'hosts', label: t('col.hosts') }, { id: 'vms', label: t('col.vms') }, { id: 'seen', label: t('col.discovered') }, { id: 'act', label: <span className="sr-only">{t('details')}</span> }]}
          cells={(c) => [<span key="n" className="flex flex-col"><span className="font-medium">{c.name}</span>{c.writeApi !== 'available' && <span className="text-xs text-warning">{t('col.writeApi')}: {t(`writeApi.${c.writeApi as 'available'}`)}</span>}</span>,
            t(`kind.${c.kind as 'esxi'}`), <Mono key="e">{c.host}:{c.port}</Mono>,
            c.status === 'ok' ? <StatusChip key="s" tone="success">{t('status.ok')}</StatusChip> : <StatusChip key="s" tone="danger">{error({ code: c.lastErrorCode })}</StatusChip>,
            c.hosts, c.vms,
            <span key="w" className={stale(c) ? 'text-warning' : 'text-muted'} title={c.lastDiscoveredAt ? format.dateTime(new Date(c.lastDiscoveredAt), { dateStyle: 'medium', timeStyle: 'short' }) : undefined}>
              {c.lastDiscoveredAt ? format.relativeTime(new Date(Math.min(Date.parse(c.lastDiscoveredAt), Date.now())), new Date()) : t('never')}</span>,
            <span key="d" className="flex gap-1">
              <Button size="sm" variant="ghost" isIconOnly aria-label={t('refreshOne', { name: c.name })} isPending={busy === c.id} isDisabled={!!busy} onPress={() => discover.mutate(c.id)}><I name="refresh-cw" size={14}/></Button>
              <ButtonLink href={`/admin/vmware/${c.id}`} variant="secondary" size="sm">{t('details')}</ButtonLink>
            </span>]}/>
      </div>}

    {list && <div className="mt-6"><Discovery onAdd={(p) => { setPrefill(p); setAdding(true); }}/></div>}

    <Modal.Backdrop isOpen={adding} onOpenChange={setAdding}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.CloseTrigger/>
          <Modal.Header><Modal.Heading>{t('addTitle')}</Modal.Heading></Modal.Header>
          <Modal.Body><ConnectionForm key={prefill ? `${prefill.host}:${prefill.port}` : 'new'} initial={prefill} onSaved={() => { setAdding(false); toast.success(t('saved')); setPrefill(undefined); client.invalidateQueries({ queryKey: ['vmware'] }); }}/></Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </>;
}
