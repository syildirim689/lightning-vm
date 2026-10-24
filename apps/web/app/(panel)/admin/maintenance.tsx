"use client";
import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { apiFetch, useErrorText } from '../../../lib/api';

type Run = { time: string; kind: 'backup' | 'restore' | 'update'; status: 'ok' | 'failed' | 'postponed'; code: string; version?: string;
  from?: string; to?: string; rolledBack?: boolean; file?: string; bytes?: number; copied?: boolean; reason?: string };
type Summary = { version: string; settings: Record<string, string>; lastBackup: Run | null; lastSuccessfulBackup: Run | null; lastUpdate: Run | null; history: Run[] };
const codes = ['E_BACKUP_KEY_MISSING', 'E_BACKUP_DB', 'E_BACKUP_VERIFY', 'E_BACKUP_COPY', 'E_RESTORE_DB', 'E_RESTORE_START',
  'E_UPDATE_FETCH', 'E_UPDATE_INCOMPATIBLE', 'E_UPDATE_FAILED', 'W_UPDATE_BUSY'] as const;

// Results come from scripts/install.sh on the host; the panel only shows them (it has no host access).
export default function Maintenance() {
  const t = useTranslations('Maintenance');
  const format = useFormatter();
  const { error } = useErrorText();
  const [data, setData] = useState<Summary>();
  const [message, setMessage] = useState<string>();
  useEffect(() => { apiFetch<Summary>('/admin/maintenance').then(setData, (e) => setMessage(error(e))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <article><h2>{t('title')}</h2><p role="status">{message ?? t('loading')}</p></article>;
  const when = (r: Run) => format.dateTime(new Date(r.time), { dateStyle: 'medium', timeStyle: 'short' });
  const reason = (r: Run) => (r.code && r.code !== '-' ? (codes.includes(r.code as typeof codes[number]) ? t(`code.${r.code as typeof codes[number]}`) : r.code) : '');
  const detail = (r: Run) => [r.from && r.to ? `${r.from} → ${r.to}` : '', r.file ?? '', r.bytes ? format.number(r.bytes / 1024 ** 2, { maximumFractionDigits: 1 }) + ' MB' : '',
    r.copied ? t('copied') : '', r.rolledBack === true ? t('rolledBack') : r.rolledBack === false ? t('notRolledBack') : '', reason(r)].filter(Boolean).join(' · ');
  const s = data.settings;
  const backup = data.lastBackup;
  return <article><h2>{t('title')}</h2>
    <ul>
      <li>{t('version', { version: data.version })}</li>
      <li>{data.lastSuccessfulBackup ? t('lastGoodBackup', { time: when(data.lastSuccessfulBackup) }) : t('noBackup')}</li>
      {backup && backup.status === 'failed' && <li className="error">{t('lastBackupFailed', { time: when(backup), reason: reason(backup) })}</li>}
      <li>{data.lastUpdate ? t('lastUpdate', { time: when(data.lastUpdate), status: t(`status.${data.lastUpdate.status}`), detail: detail(data.lastUpdate) }) : t('noUpdate')}</li>
      <li>{t('settings', { schedule: t(`onOff.${s.schedule === 'on' ? 'on' : 'off'}`), keep: s.backupKeep ?? '7', copy: t(`onOff.${s.backupCopy === 'on' ? 'on' : 'off'}`),
        auto: t(`onOff.${s.autoUpdate === 'on' ? 'on' : 'off'}`), channel: s.updateChannel ?? 'stable', window: s.updateWindow ?? '03:00-05:00' })}</li>
    </ul>
    <p className="muted">{t('explain')}</p>
    {data.history.length > 0 && <table><thead><tr><th>{t('col.time')}</th><th>{t('col.kind')}</th><th>{t('col.status')}</th><th>{t('col.detail')}</th></tr></thead>
      <tbody>{data.history.map((r, i) => <tr key={i}><td>{when(r)}</td><td>{t(`kind.${r.kind}`)}</td><td>{t(`status.${r.status}`)}</td><td>{detail(r)}</td></tr>)}</tbody></table>}
  </article>;
}
