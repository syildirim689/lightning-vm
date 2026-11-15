"use client";
// Snapshots on a server's page: take one before a risky change, go back to it, remove it. Each action is an
// operation (task list, history, notification); a revert loses everything written after the snapshot.
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../components/icon';
import { ConfirmButton, Notice, Section, StatusChip, TextInput } from '../../components/ui';
import { apiFetch, type ApiError, useErrorText } from '../../lib/api';
import { useApiQuery } from '../../lib/query';

type Snapshot = { id: string; name: string; description: string; created: string; current: boolean; parent: string };

export function ServerSnapshots({ serverId, busy }: { serverId: string; busy: boolean }) {
  const t = useTranslations('Snapshots');
  const format = useFormatter();
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ snapshots: Snapshot[]; max: number }>(['servers', serverId, 'snapshots'], `/servers/${serverId}/snapshots`, { refetchInterval: busy ? 5_000 : 60_000 });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  // When an operation on this server ends, the list may have changed.
  useEffect(() => { if (!busy) void q.refetch(); }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = q.data?.snapshots ?? [];
  const max = q.data?.max ?? 5;
  const full = list.length >= max;
  // VMware advises keeping a snapshot no longer than about three days: the delta disk grows and slows every write.
  const ageDays = (s: Snapshot) => Math.floor((Date.now() - Date.parse(s.created)) / 86_400_000);
  const old = list.filter((s) => ageDays(s) >= 3).length;
  const oldest = list.reduce<Snapshot | undefined>((a, s) => (!a || s.created < a.created ? s : a), undefined);

  async function run(path: string, method: string, body?: object) {
    setSending(true); setFields({});
    try {
      await apiFetch(path, { method, body, headers: { 'idempotency-key': crypto.randomUUID() } });
      toast.success(t('started'));
      client.invalidateQueries({ queryKey: ['servers'] }); client.invalidateQueries({ queryKey: ['tasks'] });
      return true;
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); return false; }
    finally { setSending(false); }
  }
  // A suggested name: the date and time, so the list sorts itself in the user's head.
  const suggestion = () => `${t('auto')} ${format.dateTime(new Date(), { dateStyle: 'short', timeStyle: 'short' }).replace(/[/,]/g, '.').replace(/\s+/g, ' ')}`;

  return <Section title={t('title')} description={t('help')} actions={<StatusChip tone={full ? 'warning' : 'default'}>{t('count', { n: list.length, max })}</StatusChip>}>
    <div className="flex flex-col gap-5">
      {old > 0 && <Notice tone="warning">{t('oldNotice', { n: old })}</Notice>}
      {q.isLoading ? <div className="h-16 animate-pulse rounded-lg bg-default" aria-busy/>
        : list.length === 0 ? <p className="text-sm text-muted">{t('empty')}</p>
        : <ol className="flex flex-col divide-y divide-separator rounded-lg border border-border">
          {[...list].reverse().map((s) => <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-default text-muted" aria-hidden><I name="camera" size={15}/></span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium">{s.name}{s.current && <StatusChip tone="accent">{t('current')}</StatusChip>}
                {ageDays(s) >= 3 && <StatusChip tone="warning">{t('old', { days: ageDays(s) })}</StatusChip>}</span>
              <span className="text-xs text-muted"><time dateTime={s.created} title={format.dateTime(new Date(s.created), { dateStyle: 'medium', timeStyle: 'short' })}>{format.relativeTime(new Date(s.created))}</time>
                {s.description && <> · {s.description}</>}</span>
            </div>
            <span className="flex flex-wrap gap-2">
              <ConfirmButton size="sm" variant="secondary" icon={<I name="history" size={15}/>} isDisabled={busy || sending} label={t('revert')}
                title={t('revertTitle', { name: s.name })} body={t('revertBody')} confirmLabel={t('revertYes')} cancelLabel={t('cancel')}
                onConfirm={() => run(`/servers/${serverId}/snapshots/${s.id}/revert`, 'POST').then(() => undefined)}/>
              <ConfirmButton size="sm" variant="danger-soft" icon={<I name="trash-2" size={15}/>} isDisabled={busy || sending} label={t('remove')}
                title={t('removeTitle', { name: s.name })} body={t('removeBody')} confirmLabel={t('removeYes')} cancelLabel={t('cancel')}
                onConfirm={() => run(`/servers/${serverId}/snapshots/${s.id}`, 'DELETE').then(() => undefined)}/>
            </span>
          </li>)}
        </ol>}

      <form className="flex flex-col gap-3" noValidate onSubmit={async (e) => {
        e.preventDefault();
        if (await run(`/servers/${serverId}/snapshots`, 'POST', { name: name.trim() || suggestion(), description })) { setName(''); setDescription(''); }
      }}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <TextInput label={t('name')} value={name} onChange={setName} maxLength={80} placeholder={t('namePlaceholder')} error={field(fields.name)} help={t('nameHelp')}/>
          <TextInput label={t('description')} value={description} onChange={setDescription} maxLength={500} error={field(fields.description)} help={t('optional')}/>
        </div>
        <div role="group" aria-label={t('presets')} className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">{t('presets')}:</span>
          {(['update', 'config', 'install'] as const).map((k) => <button key={k} type="button" aria-pressed={name === t(`preset.${k}`)} onClick={() => setName(t(`preset.${k}`))}
            className={`min-h-9 rounded-full border px-3 text-xs transition-colors ${name === t(`preset.${k}`) ? 'border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border hover:border-accent'}`}>{t(`preset.${k}`)}</button>)}
        </div>
        {full && <div className="flex flex-wrap items-center gap-2"><p className="text-sm text-warning">{t('full', { max })}</p>
          {oldest && <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} isDisabled={busy || sending} label={t('removeOldest', { name: oldest.name })}
            title={t('removeTitle', { name: oldest.name })} body={t('removeBody')} confirmLabel={t('removeYes')} cancelLabel={t('cancel')}
            onConfirm={() => run(`/servers/${serverId}/snapshots/${oldest.id}`, 'DELETE').then(() => undefined)}/>}</div>}
        <div><Button type="submit" isPending={sending} isDisabled={busy || full}><I name="camera" size={15}/>{t('take')}</Button></div>
      </form>
    </div>
  </Section>;
}
