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
  lastErrorCode: string | null; lastDiscoveredAt: string | null; hosts: number; vms: number; product: { fullName: string }; operations: Record<string, boolean>; warnings: string[] };

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
