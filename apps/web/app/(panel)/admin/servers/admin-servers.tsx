"use client";
import { Button, Card, Tabs } from '@heroui/react';
import NextLink from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { I } from '../../../../components/icon';
import { ConfirmButton, DataTable, Mono, Notice, PageHeader, SelectInput, StatusChip } from '../../../../components/ui';
import { useState } from 'react';
import { can } from '../../../../lib/permissions';
import { useMe } from '../../../../lib/me';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { downloadCsv } from '../../../../lib/csv';
import { useApiAction, useApiQuery } from '../../../../lib/query';
import { FavoriteStar, StateBadge, type Server } from '../../servers-ui';
import { ServerFilters, stateGroup, useServerFilters } from '../../server-filters';

type Operation = { id: string; kind: string; status: string; step: string | null; attempts: number; errorCode: string | null; errorDetail: string | null;
  createdAt: string; serverName: string | null; serverId: string | null; ownerEmail: string | null };
type Finding = { id: number; kind: string; serverId: string | null; serverName: string | null; vmMoref: string | null; detail: Record<string, string>; lastSeen: string; connectionName: string };

export default function AdminServers() {
  const t = useTranslations('Servers');
  const format = useFormatter();
  const { error } = useErrorText();
  // Tab and search live in the URL, so a view can be bookmarked and the back button works.
  const [tab, setTab] = useQueryState('tab', parseAsString.withDefault('servers'));
  const servers = useApiQuery<{ servers: Server[] }>(['admin', 'servers'], '/admin/servers', { refetchInterval: 5_000 }).data?.servers ?? [];
  const ops = useApiQuery<{ operations: Operation[] }>(['admin', 'operations'], '/admin/operations', { refetchInterval: 5_000 }).data?.operations ?? [];
  const findings = useApiQuery<{ findings: Finding[] }>(['admin', 'findings'], '/admin/reconciliation', { refetchInterval: 15_000 }).data?.findings ?? [];
  const retry = useApiAction((id: string) => apiFetch(`/admin/operations/${id}/retry`, { method: 'POST' }), { invalidate: [['admin']], success: t('admin.retried') });
  const reconcile = useApiAction(() => apiFetch('/admin/reconcile', { method: 'POST' }), { invalidate: [['admin', 'findings']], success: t('admin.reconcileQueued') });

  const filters = useServerFilters(servers);
  const me = useMe();
  const [bulkAction, setBulkAction] = useState('shutdown');
  const bulk = useApiAction((ids: string[]) => apiFetch<{ started: number; skipped: number }>('/admin/servers/actions', { method: 'POST', body: { action: bulkAction, serverIds: ids }, headers: { 'idempotency-key': crypto.randomUUID() } }),
    { invalidate: [['admin']], success: (r) => t('admin.bulkDone', { started: r.started, skipped: r.skipped }) });
  const [onlyStarred, setOnlyStarred] = useState(false);
  // Starred first; optionally only them.
  const shown = filters.shown.filter((x) => !onlyStarred || x.favorite).sort((x, y) => Number(!!y.favorite) - Number(!!x.favorite));
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
            <ServerFilters f={filters} placeholder={t('admin.search')}/>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
              <span role="status">{t('admin.shown', { shown: shown.length, total: servers.length })}</span>
              <Button size="sm" variant={onlyStarred ? 'primary' : 'ghost'} aria-pressed={onlyStarred} onPress={() => setOnlyStarred((x) => !x)}><I name="star" size={15}/>{t('admin.onlyStarred')}</Button>
              <Button size="sm" variant="secondary" isDisabled={!shown.length} onPress={() => exportCsv(shown)}><I name="download" size={15}/>{t('admin.exportCsv')}</Button>
            </div>
            {me && can(me.permissions, 'servers.manage_all') && shown.length > 0 && <div className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-end">
              <SelectInput className="sm:w-56" label={t('admin.bulkAction')} value={bulkAction} onChange={setBulkAction}
                options={(['shutdown', 'power_on', 'power_off', 'reset'] as const).map((a) => ({ id: a, label: t(`action.${a}`) }))}/>
              <ConfirmButton variant={bulkAction === 'power_off' || bulkAction === 'reset' ? 'danger' : 'primary'} icon={<I name="zap" size={15}/>} isDisabled={bulk.isPending}
                label={t('admin.bulkApply', { n: Math.min(shown.length, 200) })} title={t('admin.bulkApply', { n: Math.min(shown.length, 200) })}
                body={t('admin.bulkConfirm', { action: t(`action.${bulkAction as 'shutdown'}`), n: Math.min(shown.length, 200) })}
                confirmLabel={t('confirm.yes', { action: t(`action.${bulkAction as 'shutdown'}`) })} cancelLabel={t('confirm.no')}
                onConfirm={() => bulk.mutate(shown.slice(0, 200).map((x) => x.id))}/>
              <p className="text-xs text-muted sm:ml-2 sm:self-center">{t('admin.bulkHelp')}</p>
            </div>}
            <DataTable label={t('admin.servers')} rows={shown} rowKey={(s) => s.id} empty={t('list.empty')}
              columns={[{ id: 'name', label: t('col.name') }, { id: 'owner', label: t('admin.owner') }, { id: 'state', label: t('col.state') }, { id: 'ip', label: 'IP' }, { id: 'size', label: t('col.size') }, { id: 'loc', label: t('col.location') }, { id: 'tags', label: t('admin.tags') }]}
              cells={(s) => [<span key="n" className="flex items-center gap-1"><FavoriteStar id={s.id} on={!!s.favorite} name={s.name} listKey={['admin', 'servers']} className="relative -ml-2 shrink-0"/><NextLink href={`/servers/${s.id}`} className="font-medium text-accent hover:underline">{s.name}</NextLink>{s.locked && <I name="lock" size={13} className="text-warning"/>}</span>, s.ownerEmail ?? '–', <StateBadge key="b" server={s}/>,
                s.address ? <Mono key="ip">{s.address}</Mono> : '–', t('size', { vcpu: s.vcpu, memory: s.memoryMb / 1024, disk: s.diskGb }), s.poolName,
                s.tags?.length ? <span key="t" className="flex flex-wrap gap-1">{s.tags.map((x) => <span key={x} className="rounded-full bg-default px-2 py-0.5 text-xs">{x}</span>)}</span> : '–']}/>
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

// The filtered rows as a spreadsheet (UTF-8 with BOM so Excel keeps Turkish letters; cells quoted, formulas defused).
function exportCsv(rows: Server[]) {
  downloadCsv('servers', ['name', 'owner', 'state', 'power', 'group', 'ip', 'vcpu', 'memory_mb', 'disk_gb', 'location', 'image', 'price_monthly', 'currency', 'tags', 'created_at'],
    rows.map((s) => [s.name, s.ownerEmail, s.state, s.powerState, stateGroup(s), s.address, s.vcpu, s.memoryMb, s.diskGb, s.location || s.poolName, s.imageName, s.priceMonthly, s.currency, (s.tags ?? []).join(' '), s.createdAt]));
}
