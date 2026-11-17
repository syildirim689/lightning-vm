"use client";
// Admin → System → Restore hold: after `install.sh restore` the panel does nothing by itself from the restored
// data until an administrator has looked at what changed since the backup and releases it here (or on the
// server: `node dist/cli.js release-restore-hold`). Shown only while the hold is on.
import { useFormatter, useTranslations } from 'next-intl';
import { I } from '../../../components/icon';
import { ConfirmButton, Mono, Notice, Section } from '../../../components/ui';
import { apiFetch } from '../../../lib/api';
import { useMe } from '../../../lib/me';
import { can } from '../../../lib/permissions';
import { useApiAction, useApiQuery } from '../../../lib/query';

type Hold = { held: boolean; backup?: string; restoredAt?: string };

export default function RestoreHold() {
  const t = useTranslations('RestoreHold');
  const format = useFormatter();
  const me = useMe();
  // The API answers this to system.update only; others are not asked for something they would be refused.
  const manage = can(me?.permissions, 'system.update');
  const q = useApiQuery<Hold>(['admin', 'restore-hold'], manage ? '/admin/system/restore-hold' : null, { refetchInterval: 60_000 });
  const release = useApiAction(() => apiFetch('/admin/system/restore-hold', { method: 'DELETE' }), { invalidate: [['admin', 'restore-hold']], success: t('released') });
  const d = q.data;
  if (!d?.held) return null;
  const at = d.restoredAt ? Date.parse(d.restoredAt) : NaN;
  return <Section title={t('title')}>
    <div className="flex flex-col gap-4">
      <div role="status"><Notice tone="warning" title={t('heldTitle')}>
        {d.backup && !Number.isNaN(at) ? t('held', { backup: d.backup, time: format.dateTime(new Date(at), { dateStyle: 'medium', timeStyle: 'short' }) }) : t('heldPlain')}
      </Notice></div>
      <div className="text-sm">
        <p className="font-medium">{t('checkTitle')}</p>
        <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-muted">
          <li>{t('checkServers')}</li>
          <li>{t('checkPayments')}</li>
          <li>{t('checkAccess')}</li>
        </ol>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <ConfirmButton variant="primary" icon={<I name="play" size={16}/>} label={t('release')} title={t('releaseTitle')} body={t('releaseBody')}
          confirmLabel={t('release')} cancelLabel={t('cancel')} onConfirm={() => release.mutateAsync().then(() => undefined)}/>
        <span className="text-xs text-muted">{t('cli')} <Mono>docker compose exec api node dist/cli.js release-restore-hold</Mono></span>
      </div>
    </div>
  </Section>;
}
