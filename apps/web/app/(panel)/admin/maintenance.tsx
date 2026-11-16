"use client";
import { Button } from '@heroui/react';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { I } from '../../../components/icon';
import { downloadCsv } from '../../../lib/csv';
import { DataTable, Notice, Section, StatusChip } from '../../../components/ui';
import { useErrorText } from '../../../lib/api';
import { useApiQuery } from '../../../lib/query';

type Run = { time: string; kind: 'backup' | 'restore' | 'update'; status: 'ok' | 'failed' | 'postponed'; code: string; version?: string;
  from?: string; to?: string; rolledBack?: boolean; file?: string; bytes?: number; copied?: boolean; reason?: string };
type Summary = { version: string; settings: Record<string, string>; lastBackup: Run | null; lastSuccessfulBackup: Run | null; lastUpdate: Run | null; history: Run[] };
const codes = ['E_BACKUP_KEY_MISSING', 'E_BACKUP_DB', 'E_BACKUP_VERIFY', 'E_BACKUP_COPY', 'E_RESTORE_DB', 'E_RESTORE_START',
  'E_UPDATE_FETCH', 'E_UPDATE_INCOMPATIBLE', 'E_UPDATE_FAILED', 'W_UPDATE_BUSY', 'E_BACKUP_WRITE', 'E_UPDATE_CHECKOUT', 'UPDATE_SKIPPED'] as const;

// Results come from scripts/install.sh on the host; the panel only shows them (it has no host access).
export default function Maintenance() {
  const t = useTranslations('Maintenance');
  const format = useFormatter();
  const { error } = useErrorText();
  const now = useNow({ updateInterval: 60_000 });
  const q = useApiQuery<Summary>(['admin', 'maintenance'], '/admin/maintenance', { refetchInterval: 60_000 });
  const data = q.data;
  if (!data) return <Section title={t('title')}><p role="status" className="text-sm text-muted">{q.error ? error(q.error) : t('loading')}</p></Section>;
  const when = (r: Run) => format.dateTime(new Date(r.time), { dateStyle: 'medium', timeStyle: 'short' });
  const reason = (r: Run) => (r.code && r.code !== '-' ? (codes.includes(r.code as typeof codes[number]) ? t(`code.${r.code as typeof codes[number]}`) : r.code) : '');
  const detail = (r: Run) => [r.from && r.to ? `${r.from} → ${r.to}` : '', r.file ?? '', r.bytes ? format.number(r.bytes / 1024 ** 2, { maximumFractionDigits: 1 }) + ' MB' : '',
    r.copied ? t('copied') : '', r.rolledBack === true ? t('rolledBack') : r.rolledBack === false ? t('notRolledBack') : '', reason(r)].filter(Boolean).join(' · ');
  const s = data.settings;
  const backup = data.lastBackup;
  const onOff = (v?: string) => t(`onOff.${v === 'on' ? 'on' : 'off'}`);
  // A good backup older than two days, while the latest attempt did not fail (that has its own notice).
  const ageDays = data.lastSuccessfulBackup ? Math.floor((now.getTime() - Date.parse(data.lastSuccessfulBackup.time)) / 86_400_000) : null;
  return <Section title={t('title')} description={t('explain')} actions={data.history.length > 0 && <Button size="sm" variant="ghost"
    onPress={() => downloadCsv('maintenance', ['time', 'kind', 'status', 'detail'], data.history.map((r) => [r.time, t(`kind.${r.kind}`), t(`status.${r.status}`), detail(r)]))}>
    <I name="download" size={14}/>{t('export')}</Button>}>
    <div className="flex flex-col gap-4">
      <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg bg-default/60 p-3"><dt className="text-xs text-muted">{t('versionLabel')}</dt><dd className="mt-1 font-mono">{data.version}</dd></div>
        <div className="rounded-lg bg-default/60 p-3"><dt className="text-xs text-muted">{t('lastBackupLabel')}</dt>
          <dd className="mt-1">{data.lastSuccessfulBackup ? t('lastGoodBackup', { time: when(data.lastSuccessfulBackup) }) : t('noBackup')}</dd></div>
        <div className="rounded-lg bg-default/60 p-3"><dt className="text-xs text-muted">{t('lastUpdateLabel')}</dt>
          <dd className="mt-1">{data.lastUpdate ? t('lastUpdate', { time: when(data.lastUpdate), status: t(`status.${data.lastUpdate.status}`), detail: detail(data.lastUpdate) }) : t('noUpdate')}</dd></div>
        <div className="rounded-lg bg-default/60 p-3"><dt className="text-xs text-muted">{t('settingsLabel')}</dt>
          <dd className="mt-1">{t('settings', { schedule: onOff(s.schedule), keep: s.backupKeep ?? '7', copy: onOff(s.backupCopy), auto: onOff(s.autoUpdate), channel: s.updateChannel ?? 'stable', window: s.updateWindow ?? '03:00-05:00' })}</dd></div>
      </dl>
      {backup?.status === 'failed' && <Notice tone="danger">{t('lastBackupFailed', { time: when(backup), reason: reason(backup) })}</Notice>}
      {backup?.status !== 'failed' && ageDays !== null && ageDays >= 2 && <Notice tone="warning">{t('backupOld', { days: ageDays })}</Notice>}
      {data.history.length > 0 && <DataTable label={t('title')} rows={data.history} rowKey={(r) => `${r.time}-${r.kind}-${r.status}`}
        columns={[{ id: 'time', label: t('col.time') }, { id: 'kind', label: t('col.kind') }, { id: 'status', label: t('col.status') }, { id: 'detail', label: t('col.detail') }]}
        cells={(r) => [when(r), t(`kind.${r.kind}`), <StatusChip key="s" tone={r.status === 'ok' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>{t(`status.${r.status}`)}</StatusChip>, detail(r)]}/>}
    </div>
  </Section>;
}
