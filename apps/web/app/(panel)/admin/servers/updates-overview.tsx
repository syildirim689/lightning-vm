"use client";
// The update state of every Linux server in one list (the reporter inside each server sends it): which wait for
// security updates, which need a restart, whose reporter went silent and which are not tracked at all. Security
// updates can be started on all reporting servers at once; everything else is done on the server's own page.
import { SearchField, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { I } from '../../../../components/icon';
import { Ago, ConfirmButton, DataTable, Notice, StatusChip } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { fold } from '../../../../lib/note-line';
import { useApiQuery } from '../../../../lib/query';

type Row = { id: string; name: string; state: string; ownerEmail: string; image: string; tracked: boolean; auto: boolean; reported: boolean; reportedAt: string | null; stale: boolean;
  policy: 'notify' | 'security' | 'all' | null; autoReboot: boolean | null; os: string | null; manager: string | null; total: number; security: number; rebootRequired: boolean;
  pendingAction: string | null; lastRun: { action: string; state: 'running' | 'succeeded' | 'failed' } | null };

const groups = ['all', 'security', 'restart', 'silent', 'untracked'] as const;
const inGroup = (r: Row, g: typeof groups[number]) => g === 'all' || (g === 'security' ? r.reported && r.security > 0 : g === 'restart' ? r.reported && r.rebootRequired
  : g === 'silent' ? r.tracked && (!r.reported || r.stale) : !r.tracked);
// The reporter answers and is free: an install asked for now will be picked up.
const ready = (r: Row) => r.state === 'ready' && r.reported && !r.stale && !r.pendingAction && r.lastRun?.state !== 'running';

export const useUpdatesOverview = () => useApiQuery<{ servers: Row[] }>(['admin', 'server-updates'], '/admin/server-updates', { refetchInterval: 60_000 });

export function UpdatesOverview({ canManage }: { canManage: boolean }) {
  const t = useTranslations('GuestUpdates');
  const { error } = useErrorText();
  const client = useQueryClient();
  const q = useUpdatesOverview();
  const [show, setShow] = useQueryState('upd', parseAsStringLiteral(groups).withDefault('all').withOptions({ history: 'replace' }));
  const [find, setFind] = useQueryState('updq', parseAsString.withDefault('').withOptions({ history: 'replace', throttleMs: 300 }));
  if (!q.data) return <p role="status" className="flex items-center gap-2 text-sm text-muted"><I name="loader" size={14} className="animate-spin"/>{t('admin.loading')}</p>;
  const rows = q.data.servers;
  if (!rows.length) return <Notice tone="default">{t('admin.none')}</Notice>;
  const needle = fold(find.trim());
  const shown = rows.filter((r) => inGroup(r, show) && (!needle || fold(`${r.name} ${r.ownerEmail} ${r.os ?? r.image}`).includes(needle)));
  const targets = rows.filter((r) => ready(r) && r.security > 0);

  async function installSecurity() {
    try {
      // The API takes at most 500 servers in one request: a larger fleet goes in several.
      const ids = targets.map((x) => x.id);
      const r = { started: 0, skipped: 0 };
      for (let i = 0; i < ids.length; i += 500) {
        const part = await apiFetch<{ started: number; skipped: number }>('/admin/server-updates/actions', { method: 'POST', body: { action: 'security', serverIds: ids.slice(i, i + 500) } });
        r.started += part.started; r.skipped += part.skipped;
      }
      toast.success(t('admin.asked', { started: r.started, skipped: r.skipped }));
      await client.invalidateQueries({ queryKey: ['admin', 'server-updates'] });
    } catch (e) { toast.danger(error(e)); throw e; }
  }

  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-2xl text-sm text-muted">{t('admin.intro')}</p>
      {canManage && <ConfirmButton variant="primary" icon={<I name="shield-check" size={16}/>} label={t('admin.installSecurity', { n: targets.length })} isDisabled={!targets.length}
        title={t('admin.installTitle', { n: targets.length })} body={t('admin.installBody')} confirmLabel={t('install')} cancelLabel={t('cancel')} onConfirm={installSecurity}/>}
    </div>
    <div className="flex flex-col gap-2 md:flex-row md:items-center">
      <SearchField aria-label={t('admin.find')} value={find} onChange={setFind} className="w-full md:w-72">
        <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('admin.find')}/><SearchField.ClearButton/></SearchField.Group>
      </SearchField>
      <div role="group" aria-label={t('admin.show')} className="flex flex-wrap gap-1.5">
        {groups.map((g) => <button key={g} type="button" aria-pressed={show === g} onClick={() => setShow(g)}
          className={`min-h-10 rounded-lg border px-3 text-sm transition-colors ${show === g ? 'border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border hover:border-accent'}`}>
          {t(`admin.group.${g}`)} <span className="tabular-nums text-muted">{rows.filter((r) => inGroup(r, g)).length}</span></button>)}
      </div>
    </div>
    <DataTable label={t('admin.title')} rows={shown} rowKey={(r) => r.id} minWidth={820} empty={t('admin.noMatch')}
      sortBy={{ name: (r) => r.name, os: (r) => r.os ?? r.image, updates: (r) => (r.reported ? r.security * 100_000 + r.total : -1), restart: (r) => Number(r.rebootRequired),
        policy: (r) => r.policy, report: (r) => (r.reportedAt ? Date.parse(r.reportedAt) : 0) }}
      columns={[{ id: 'name', label: t('admin.col.server') }, { id: 'os', label: t('admin.col.os') }, { id: 'updates', label: t('admin.col.updates') }, { id: 'restart', label: t('restart') },
        { id: 'policy', label: t('admin.col.policy') }, { id: 'report', label: t('admin.col.report') }]}
      cells={(r) => [
        <span key="n" className="flex flex-col"><NextLink href={`/servers/${r.id}`} className="font-medium text-accent hover:underline">{r.name}</NextLink><span className="text-xs text-muted">{r.ownerEmail}</span></span>,
        <span key="o" className="text-sm">{r.os ?? r.image}</span>,
        !r.tracked ? <span key="u" className="text-sm text-muted">{t('admin.untracked')}</span>
          : !r.reported ? <span key="u" className="text-sm text-muted">{t(r.auto ? 'admin.installing' : 'waitingTitle')}</span>
          : r.total === 0 ? <StatusChip key="u" tone="success">{t('admin.upToDate')}</StatusChip>
          : <span key="u" className="flex flex-wrap items-center gap-1.5"><span className="tabular-nums">{t('admin.count', { n: r.total })}</span>{r.security > 0 && <StatusChip tone="danger">{t('admin.securityCount', { n: r.security })}</StatusChip>}
            {(r.pendingAction || r.lastRun?.state === 'running') && <span className="inline-flex" title={t('admin.working')}><I name="loader" size={13} className="animate-spin text-accent"/><span className="sr-only">{t('admin.working')}</span></span>}</span>,
        r.reported && r.rebootRequired ? <StatusChip key="r" tone="warning">{t('restartNeeded')}</StatusChip> : <span key="r" className="text-muted">–</span>,
        r.tracked && r.policy ? <span key="p" className="flex flex-col text-sm"><span>{t(`policy.${r.policy}`)}</span>{r.autoReboot && <span className="text-xs text-muted">{t('admin.autoReboot')}</span>}</span> : <span key="p" className="text-muted">–</span>,
        r.reportedAt ? <span key="a" className="flex flex-wrap items-center gap-1.5 text-sm"><Ago at={r.reportedAt}/>{r.stale && <StatusChip tone="warning">{t('admin.silent')}</StatusChip>}</span> : <span key="a" className="text-muted">–</span>]}/>
  </div>;
}
