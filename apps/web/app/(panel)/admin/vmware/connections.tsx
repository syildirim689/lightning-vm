"use client";
import { Button, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { I } from '../../../../components/icon';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useErrorText } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';
import { ButtonLink, DataTable, Empty, Mono, PageHeader, StatusChip } from '../../../../components/ui';
import ConnectionForm from './connection-form';

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
  const list = useApiQuery<{ connections: Connection[] }>(['vmware', 'connections'], '/admin/vmware/connections').data?.connections;

  return <>
    <PageHeader eyebrow={eyebrow} title={title} description={intro}
      actions={<Button onPress={() => setAdding(true)}><I name="plus" size={16}/>{t('add')}</Button>}/>
    {!list ? <p role="status" className="text-sm text-muted">{t('loading')}</p>
      : list.length === 0 ? <Empty icon={<I name="cable" size={28}/>} title={t('empty')}/>
      : <DataTable label={t('title')} rows={list} rowKey={(c) => c.id}
          columns={[{ id: 'name', label: t('col.name') }, { id: 'kind', label: t('col.kind') }, { id: 'endpoint', label: t('col.endpoint') }, { id: 'status', label: t('col.status') },
            { id: 'hosts', label: t('col.hosts') }, { id: 'vms', label: t('col.vms') }, { id: 'write', label: t('col.writeApi') }, { id: 'open', label: <span className="sr-only">{t('details')}</span> }]}
          cells={(c) => [<span key="n" className="font-medium">{c.name}</span>, t(`kind.${c.kind as 'esxi'}`), <Mono key="e">{c.host}:{c.port}</Mono>,
            c.status === 'ok' ? <StatusChip key="s" tone="success">{t('status.ok')}</StatusChip> : <StatusChip key="s" tone="danger">{error({ code: c.lastErrorCode })}</StatusChip>,
            c.hosts, c.vms, t(`writeApi.${c.writeApi as 'available'}`), <ButtonLink key="d" href={`/admin/vmware/${c.id}`} variant="secondary" size="sm">{t('details')}</ButtonLink>]}/>}

    <Modal.Backdrop isOpen={adding} onOpenChange={setAdding}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.CloseTrigger/>
          <Modal.Header><Modal.Heading>{t('addTitle')}</Modal.Heading></Modal.Header>
          <Modal.Body><ConnectionForm onSaved={() => { setAdding(false); toast.success(t('saved')); client.invalidateQueries({ queryKey: ['vmware'] }); }}/></Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </>;
}
