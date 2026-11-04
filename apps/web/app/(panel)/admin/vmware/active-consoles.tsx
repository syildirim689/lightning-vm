"use client";
import { Button } from '@heroui/react';
import { useFormatter, useTranslations } from 'next-intl';
import { apiFetch } from '../../../../lib/api';
import { useApiAction, useApiQuery } from '../../../../lib/query';
import { DataTable, Section } from '../../../../components/ui';

type Session = { key: string; userId: string; email: string | null; vm: string; vmName: string; startedAt: string };

// Live consoles across all users; an admin can end any of them (the gateway closes it at once).
export default function ActiveConsoles() {
  const t = useTranslations('Console');
  const format = useFormatter();
  const sessions = useApiQuery<{ sessions: Session[] }>(['consoles'], '/admin/console/sessions', { refetchInterval: 10_000 }).data?.sessions;
  const revoke = useApiAction((key: string) => apiFetch(`/admin/console/sessions/${key}/revoke`, { method: 'POST' }), { invalidate: [['consoles']], success: t('revoked') });
  return <Section title={t('activeTitle')} actions={!!sessions?.length && <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium tabular-nums text-accent">{sessions.length}</span>}>
    <DataTable label={t('activeTitle')} rows={sessions ?? []} rowKey={(s) => s.key} empty={t('activeEmpty')} minWidth={520}
      columns={[{ id: 'user', label: t('col.user') }, { id: 'vm', label: t('col.vm') }, { id: 'since', label: t('col.since') }, { id: 'act', label: <span className="sr-only">{t('revoke')}</span> }]}
      cells={(s) => [s.email ?? s.userId, s.vmName || s.vm,
        <span key="t" title={format.dateTime(new Date(s.startedAt), { dateStyle: 'medium', timeStyle: 'short' })}>{format.dateTime(new Date(s.startedAt), { timeStyle: 'short' })}
          <span className="ml-1 text-xs text-muted">· {format.relativeTime(new Date(Math.min(Date.parse(s.startedAt), Date.now())), new Date())}</span></span>,
        <Button key="r" size="sm" variant="danger-soft" isPending={revoke.isPending && revoke.variables === s.key} onPress={() => revoke.mutate(s.key)}>{t('revoke')}</Button>]}/>
  </Section>;
}
