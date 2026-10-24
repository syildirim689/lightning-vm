"use client";
import { Button, Card, SearchField, Tabs } from '@heroui/react';
import NextLink from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { I } from '../../../../components/icon';
import { DataTable, Mono, Notice, PageHeader, StatusChip } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useApiAction, useApiQuery } from '../../../../lib/query';
import { StateBadge, type Server } from '../../servers-ui';

type Operation = { id: string; kind: string; status: string; step: string | null; attempts: number; errorCode: string | null; errorDetail: string | null;
  createdAt: string; serverName: string | null; serverId: string | null; ownerEmail: string | null };
type Finding = { id: number; kind: string; serverId: string | null; serverName: string | null; vmMoref: string | null; detail: Record<string, string>; lastSeen: string; connectionName: string };

export default function AdminServers() {
  const t = useTranslations('Servers');
  const format = useFormatter();
  const { error } = useErrorText();
  // Tab and search live in the URL, so a view can be bookmarked and the back button works.
  const [tab, setTab] = useQueryState('tab', parseAsString.withDefault('servers'));
  const [search, setSearch] = useQueryState('q', parseAsString.withDefault(''));
  const servers = useApiQuery<{ servers: Server[] }>(['admin', 'servers'], '/admin/servers', { refetchInterval: 5_000 }).data?.servers ?? [];
  const ops = useApiQuery<{ operations: Operation[] }>(['admin', 'operations'], '/admin/operations', { refetchInterval: 5_000 }).data?.operations ?? [];
  const findings = useApiQuery<{ findings: Finding[] }>(['admin', 'findings'], '/admin/reconciliation', { refetchInterval: 15_000 }).data?.findings ?? [];
  const retry = useApiAction((id: string) => apiFetch(`/admin/operations/${id}/retry`, { method: 'POST' }), { invalidate: [['admin']], success: t('admin.retried') });
  const reconcile = useApiAction(() => apiFetch('/admin/reconcile', { method: 'POST' }), { invalidate: [['admin', 'findings']], success: t('admin.reconcileQueued') });

  const needle = search.trim().toLowerCase();
  const shown = needle ? servers.filter((s) => [s.name, s.ownerEmail, s.address, s.poolName].some((v) => v?.toLowerCase().includes(needle))) : servers;
  const failed = ops.filter((o) => o.status === 'failed').length;
  const opTone = (s: string) => (s === 'succeeded' ? 'success' : s === 'failed' ? 'danger' : s === 'cancelled' ? 'default' : 'accent') as 'success';

  return <>
    <PageHeader eyebrow={t('admin.eyebrow')} title={t('admin.title')} description={t('admin.intro')}/>
    <Card>
      <Card.Content>
        <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}>
          <Tabs.ListContainer>
            <Tabs.List aria-label={t('admin.title')}>
              <Tabs.Tab id="servers">{t('admin.servers')} <span className="ml-1 text-xs text-muted">{servers.length}</span><Tabs.Indicator/></Tabs.Tab>
              <Tabs.Tab id="operations">{t('admin.operations')}{failed > 0 && <StatusChip tone="danger">{failed}</StatusChip>}<Tabs.Indicator/></Tabs.Tab>
              <Tabs.Tab id="reconciliation">{t('admin.reconciliation')}{findings.length > 0 && <StatusChip tone="warning">{findings.length}</StatusChip>}<Tabs.Indicator/></Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>

          <Tabs.Panel id="servers" className="flex flex-col gap-4 pt-4">
            <h2 className="sr-only">{t('admin.servers')}</h2>
            <SearchField aria-label={t('admin.search')} value={search} onChange={(v) => setSearch(v || null)} className="max-w-sm">
              <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('admin.search')}/><SearchField.ClearButton/></SearchField.Group>
            </SearchField>
            <DataTable label={t('admin.servers')} rows={shown} rowKey={(s) => s.id} empty={t('list.empty')}
              columns={[{ id: 'name', label: t('col.name') }, { id: 'owner', label: t('admin.owner') }, { id: 'state', label: t('col.state') }, { id: 'ip', label: 'IP' }, { id: 'size', label: t('col.size') }, { id: 'loc', label: t('col.location') }]}
              cells={(s) => [<NextLink key="n" href={`/servers/${s.id}`} className="font-medium text-accent hover:underline">{s.name}</NextLink>, s.ownerEmail ?? '–', <StateBadge key="b" server={s}/>,
                s.address ? <Mono key="ip">{s.address}</Mono> : '–', t('size', { vcpu: s.vcpu, memory: s.memoryMb / 1024, disk: s.diskGb }), s.poolName]}/>
          </Tabs.Panel>

          <Tabs.Panel id="operations" className="pt-4">
            <h2 className="sr-only">{t('admin.operations')}</h2>
            <DataTable label={t('admin.operations')} rows={ops} rowKey={(o) => o.id} minWidth={760}
              columns={[{ id: 'when', label: t('col.when') }, { id: 'op', label: t('col.operation') }, { id: 'name', label: t('col.name') }, { id: 'state', label: t('col.state') }, { id: 'detail', label: t('col.detail') }, { id: 'act', label: <span className="sr-only">{t('admin.retry')}</span> }]}
              cells={(o) => [format.dateTime(new Date(o.createdAt), { dateStyle: 'short', timeStyle: 'medium' }), t(`kind.${o.kind as 'create'}`), o.serverName ?? '–',
                <StatusChip key="s" tone={opTone(o.status)}>{t(`opStatus.${o.status as 'pending'}`)}{o.attempts > 1 ? ` · ${t('attempt', { n: o.attempts })}` : ''}</StatusChip>,
                o.errorCode ? t('errorCode', { message: error({ code: o.errorCode }), code: o.errorCode }) : o.step ? t(`step.${o.step as 'queued'}`) : '',
                o.status === 'failed' ? <Button key="r" size="sm" variant="secondary" onPress={() => retry.mutate(o.id)}><I name="rotate-cw" size={14}/>{t('admin.retry')}</Button> : null]}/>
          </Tabs.Panel>

          <Tabs.Panel id="reconciliation" className="flex flex-col gap-4 pt-4">
            <h2 className="sr-only">{t('admin.reconciliation')}</h2>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-2xl text-sm text-muted">{t('admin.reconcileExplain')}</p>
              <Button variant="secondary" isPending={reconcile.isPending} onPress={() => reconcile.mutate()}><I name="scan-search" size={16}/>{t('admin.reconcile')}</Button>
            </div>
            {findings.length === 0 ? <Notice tone="success">{t('admin.noFindings')}</Notice>
              : <DataTable label={t('admin.reconciliation')} rows={findings} rowKey={(f) => String(f.id)}
                  columns={[{ id: 'when', label: t('col.when') }, { id: 'kind', label: t('admin.finding') }, { id: 'name', label: t('col.name') }, { id: 'detail', label: t('col.detail') }]}
                  cells={(f) => [format.dateTime(new Date(f.lastSeen), { dateStyle: 'short', timeStyle: 'short' }), <StatusChip key="k" tone="warning">{t(`finding.${f.kind as 'vm_missing'}`)}</StatusChip>,
                    f.serverName ?? f.detail.name ?? f.vmMoref ?? '–', `${f.connectionName}${f.detail.actual ? ` · ${f.detail.recorded} → ${f.detail.actual}` : ''}`]}/>}
          </Tabs.Panel>
        </Tabs>
      </Card.Content>
    </Card>
  </>;
}
