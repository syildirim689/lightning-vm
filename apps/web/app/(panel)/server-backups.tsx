"use client";
// Backups on a server's page: take one (a copy of the disk on the location's backup storage, taken while the server
// runs), restore one over the disk (the server is stopped and started again), remove one. Scheduled ones come from
// the schedules above ("Nightly backup").
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../components/icon';
import { ConfirmButton, Notice, Section, StatusChip, TextInput } from '../../components/ui';
import { apiFetch, type ApiError, useErrorText } from '../../lib/api';
import { useApiQuery } from '../../lib/query';

type Backup = { id: string; kind: 'manual' | 'scheduled'; note: string; status: 'pending' | 'running' | 'ready' | 'failed'; sizeGb: number | null; errorCode: string | null; createdAt: string; finishedAt: string | null };

export function ServerBackups({ serverId, serverName, busy }: { serverId: string; serverName: string; busy: boolean }) {
  const t = useTranslations('Backups');
  const format = useFormatter();
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ backups: Backup[]; max: number; available: boolean }>(['servers', serverId, 'backups'], `/servers/${serverId}/backups`, { refetchInterval: busy ? 5_000 : 60_000 });
  const [note, setNote] = useState('');
  const [restoring, setRestoring] = useState<string>();
  const [confirm, setConfirm] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  useEffect(() => { if (!busy) void q.refetch(); }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!q.data) return null;
  if (!q.data.available) return <Section title={t('title')}><Notice tone="default">{t('notConfigured')}</Notice></Section>;
  const list = q.data.backups;
  const full = list.filter((b) => b.status !== 'failed').length >= q.data.max;

  async function run(path: string, method: string, body: object | undefined, done: string) {
    setSending(true); setFields({});
    try {
      await apiFetch(path, { method, body });
      toast.success(done); setNote(''); setRestoring(undefined); setConfirm('');
      client.invalidateQueries({ queryKey: ['servers'] }); client.invalidateQueries({ queryKey: ['tasks'] });
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setSending(false); }
  }

  return <Section title={t('title')} description={t('help')} actions={<StatusChip tone={full ? 'warning' : 'default'}>{t('count', { n: list.filter((b) => b.status !== 'failed').length, max: q.data.max })}</StatusChip>}>
    <div className="flex flex-col gap-5">
      {list.length === 0 ? <p className="text-sm text-muted">{t('empty')}</p>
        : <ol className="flex flex-col divide-y divide-separator rounded-lg border border-border">
          {list.map((b) => <li key={b.id} className="flex flex-col gap-3 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-default text-muted" aria-hidden>{b.kind === 'manual' ? <I name="archive" size={15}/> : <I name="calendar-clock" size={15}/>}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{format.dateTime(new Date(b.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}{b.note && <span className="text-muted"> · {b.note}</span>}</span>
                <span className="text-xs text-muted">{t(`kind.${b.kind}`)}{b.sizeGb ? ` · ${b.sizeGb} GB` : ''}{b.errorCode ? ` · ${error({ code: b.errorCode })}` : ''}</span>
              </span>
              <StatusChip tone={b.status === 'ready' ? 'success' : b.status === 'failed' ? 'danger' : 'accent'}>{t(`status.${b.status}`)}</StatusChip>
              <span className="flex gap-1">
                {b.status === 'ready' && <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => setRestoring(restoring === b.id ? undefined : b.id)}><I name="history" size={14}/>{t('restore')}</Button>}
                {(b.status === 'ready' || b.status === 'failed') && <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={<span className="sr-only sm:not-sr-only">{t('remove')}</span>}
                  title={t('removeTitle')} body={t('removeBody')} confirmLabel={t('remove')} cancelLabel={t('cancel')} isDisabled={busy}
                  onConfirm={() => run(`/servers/${serverId}/backups/${b.id}`, 'DELETE', undefined, t('removing'))}/>}
              </span>
            </div>
            {restoring === b.id && <div className="flex flex-col gap-3 rounded-xl border border-danger/40 bg-danger/5 p-3">
              <p className="text-sm">{t('restoreWarning')}</p>
              <div className="flex flex-wrap items-end gap-3">
                <TextInput className="min-w-64 flex-1" label={t('confirm', { name: serverName })} value={confirm} onChange={setConfirm} autoComplete="off" error={field(fields.confirm)}/>
                <Button variant="danger" isPending={sending} isDisabled={confirm !== serverName} onPress={() => run(`/servers/${serverId}/backups/${b.id}/restore`, 'POST', { confirm }, t('restoring'))}>
                  <I name="history" size={15}/>{t('restoreNow')}</Button>
              </div>
            </div>}
          </li>)}
        </ol>}
      <div className="flex flex-wrap items-end gap-3">
        <TextInput className="min-w-56 flex-1" label={t('note')} value={note} onChange={setNote} maxLength={120} placeholder={t('notePlaceholder')}/>
        <Button isPending={sending} isDisabled={busy || full} onPress={() => run(`/servers/${serverId}/backups`, 'POST', { note }, t('started'))}><I name="archive" size={16}/>{t('take')}</Button>
      </div>
      {full && <p className="text-xs text-muted">{t('full')}</p>}
    </div>
  </Section>;
}
