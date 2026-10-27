"use client";
// Schedules on a server's page: start, shut down or take a snapshot at a local time on chosen weekdays. Times are in
// the browser's time zone, saved with each schedule; "Office hours" and "Nightly snapshot" add the usual ones in one click.
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../components/icon';
import { Section, SelectInput, StatusChip, SwitchInput, TextInput } from '../../components/ui';
import { apiFetch, useErrorText } from '../../lib/api';
import { useApiForm } from '../../lib/form';
import { useApiAction, useApiQuery } from '../../lib/query';

type Schedule = { id: string; action: 'power_on' | 'shutdown' | 'snapshot' | 'backup'; keep: number | null; days: number[]; time: string; timezone: string; enabled: boolean; lastRunAt: string | null; lastResult: string | null };
const week = [1, 2, 3, 4, 5, 6, 7];

export function PowerSchedules({ serverId, power = true, snapshots = false, backups = false }: { serverId: string; power?: boolean; snapshots?: boolean; backups?: boolean }) {
  const t = useTranslations('Schedules');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const key = ['servers', serverId, 'schedules'];
  const list = useApiQuery<{ schedules: Schedule[] }>(key, `/servers/${serverId}/schedules`).data?.schedules;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const f = useApiForm({ action: power ? 'shutdown' : snapshots ? 'snapshot' : 'backup', days: [1, 2, 3, 4, 5], time: power ? '19:00' : '02:00', timezone: zone, keep: '3' });
  const [busy, setBusy] = useState(false);
  const toggle = useApiAction((s: Schedule) => apiFetch(`/servers/${serverId}/schedules/${s.id}`, { method: 'PUT', body: { ...s, enabled: !s.enabled } }), { invalidate: [key] });
  const remove = useApiAction((id: string) => apiFetch(`/servers/${serverId}/schedules/${id}`, { method: 'DELETE' }), { invalidate: [key], success: t('removed') });
  // Monday 2024-01-01 is ISO weekday 1, so day d is 2024-01-0d.
  const dayName = (d: number, style: 'short' | 'long') => format.dateTime(new Date(2024, 0, d), { weekday: style });
  const daysText = (days: number[]) => days.length === 7 ? t('everyDay') : days.join() === '1,2,3,4,5' ? t('weekdays') : days.join() === '6,7' ? t('weekend') : days.map((d) => dayName(d, 'short')).join(', ');
  const reload = () => client.invalidateQueries({ queryKey: key });

  async function preset(items: Record<string, unknown>[]) {
    setBusy(true);
    try {
      for (const body of items) await apiFetch(`/servers/${serverId}/schedules`, { method: 'POST', body: { timezone: zone, ...body } });
      toast.success(t('added'));
    } catch (e) { toast.danger(error(e)); }
    finally { setBusy(false); await reload(); }
  }

  return <Section title={t('title')} description={t('help', { zone })}
    actions={<span className="flex flex-wrap gap-2">
      {power && <Button size="sm" variant="secondary" isPending={busy} onPress={() => preset([{ action: 'power_on', days: [1, 2, 3, 4, 5], time: '08:00' }, { action: 'shutdown', days: [1, 2, 3, 4, 5], time: '19:00' }])}><I name="briefcase" size={15}/>{t('officeHours')}</Button>}
      {snapshots && <Button size="sm" variant="secondary" isPending={busy} onPress={() => preset([{ action: 'snapshot', days: week, time: '02:00', keep: 3 }])}><I name="camera" size={15}/>{t('nightly')}</Button>}
      {backups && <Button size="sm" variant="secondary" isPending={busy} onPress={() => preset([{ action: 'backup', days: week, time: '03:00', keep: 7 }])}><I name="archive" size={15}/>{t('nightlyBackup')}</Button>}
    </span>}>
    <div className="flex flex-col gap-5">
      {list && list.length > 0 && <ul className="flex flex-col divide-y divide-separator rounded-lg border border-border">
        {list.map((s) => <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
          <span className={`flex items-center gap-2 font-medium ${s.enabled ? '' : 'text-muted'}`}>
            {s.action === 'power_on' ? <I name="sunrise" size={16} className="text-success"/> : s.action === 'snapshot' ? <I name="camera" size={16} className="text-warning"/> : s.action === 'backup' ? <I name="archive" size={16} className="text-success"/> : <I name="moon" size={16} className="text-accent"/>}{t(`action.${s.action}`)}</span>
          <span className="tabular-nums">{s.time}</span>
          <span className="text-sm text-muted">{daysText(s.days)}{s.timezone !== zone && ` · ${s.timezone}`}{(s.action === 'snapshot' || s.action === 'backup') && s.keep && ` · ${t('keeps', { n: s.keep })}`}</span>
          {s.lastResult && <StatusChip tone={s.lastResult === 'started' ? 'success' : s.lastResult === 'failed' ? 'danger' : s.lastResult === 'rotating' ? 'accent' : 'default'}>
            {t(`result.${s.lastResult as 'started'}`)}{s.lastRunAt && ` · ${format.relativeTime(new Date(s.lastRunAt))}`}</StatusChip>}
          <span className="ml-auto flex items-center gap-1">
            <SwitchInput isSelected={s.enabled} onChange={() => toggle.mutate(s)} label={<span className="sr-only">{t('enabledFor', { action: t(`action.${s.action}`), time: s.time })}</span>}/>
            <Button size="sm" variant="ghost" isIconOnly aria-label={t('remove', { action: t(`action.${s.action}`), time: s.time })} className="min-h-9 min-w-9" onPress={() => remove.mutate(s.id)}><I name="trash-2" size={15}/></Button>
          </span>
        </li>)}
      </ul>}
      {list && list.length === 0 && <p className="text-sm text-muted">{t('empty')}</p>}

      <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => {
        e.preventDefault();
        if (await f.submit('POST', `/servers/${serverId}/schedules`)) { toast.success(t('added')); await reload(); }
      }}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectInput label={t('what')} value={f.values.action} onChange={f.set('action')} error={f.fieldError('action')}
            options={[...(power ? [{ id: 'shutdown', label: t('action.shutdown') }, { id: 'power_on', label: t('action.power_on') }] : []), ...(snapshots ? [{ id: 'snapshot', label: t('action.snapshot') }] : []), ...(backups ? [{ id: 'backup', label: t('action.backup') }] : [])]}/>
          <TextInput label={t('at')} type="time" value={f.values.time} onChange={f.set('time')} error={f.fieldError('time')}/>
          {(f.values.action === 'snapshot' || f.values.action === 'backup') && <TextInput label={t('keep')} type="number" value={f.values.keep} onChange={f.set('keep')} error={f.fieldError('keep')} help={t('keepHelp')} autoComplete="off"/>}
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('days')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {week.map((d) => { const on = f.values.days.includes(d); return <button key={d} type="button" aria-pressed={on} aria-label={dayName(d, 'long')}
              onClick={() => f.set('days')(on ? f.values.days.filter((x) => x !== d) : [...f.values.days, d].sort())}
              className={`min-h-11 min-w-11 rounded-lg border px-2 text-sm transition-colors duration-150 ${on ? 'border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border hover:border-accent'}`}>{dayName(d, 'short')}</button>; })}
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            {([['weekdays', [1, 2, 3, 4, 5]], ['weekend', [6, 7]], ['everyDay', week]] as const).map(([k, days]) => <button key={k} type="button" className="text-accent hover:underline" onClick={() => f.set('days')([...days])}>{t(k)}</button>)}
          </div>
          {f.fieldError('days') && <p className="text-sm text-danger">{f.fieldError('days')}</p>}
        </fieldset>
        {f.failure && !f.failure.fields && <p role="alert" className="text-sm text-danger">{f.failure.text}</p>}
        <div><Button type="submit" isPending={f.busy}><I name="calendar-clock" size={15}/>{t('add')}</Button></div>
      </form>
    </div>
  </Section>;
}
