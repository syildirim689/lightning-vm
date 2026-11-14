"use client";
// Schedules on a server's page: start, shut down or take a snapshot at a local time on chosen weekdays. Times are in
// the browser's time zone, saved with each schedule; "Office hours" and "Nightly snapshot" add the usual ones in one click.
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../components/icon';
import { Ago, ConfirmButton, Notice, Section, SelectInput, StatusChip, SwitchInput, TextInput } from '../../components/ui';
import { apiFetch, useErrorText } from '../../lib/api';
import { useApiForm } from '../../lib/form';
import { useApiAction, useApiQuery } from '../../lib/query';
import { clashes, nextRun, sameJob } from '../../lib/schedule';

type Schedule = { id: string; action: 'power_on' | 'shutdown' | 'snapshot' | 'backup'; keep: number | null; days: number[]; time: string; timezone: string; enabled: boolean; lastRunAt: string | null; lastResult: string | null };
const week = [1, 2, 3, 4, 5, 6, 7];
const icon = (a: Schedule['action']) => a === 'power_on' ? <I name="sunrise" size={14} className="text-success"/> : a === 'snapshot' ? <I name="camera" size={14} className="text-warning"/>
  : a === 'backup' ? <I name="archive" size={14} className="text-success"/> : <I name="moon" size={14} className="text-accent"/>;


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

  async function preset(items: { action: string; days: number[]; time: string; keep?: number }[]) {
    const missing = items.filter((x) => !(list ?? []).some((s) => sameJob(s, { ...x, timezone: zone })));
    if (!missing.length) { toast.info(t('alreadyThere')); return; }
    setBusy(true);
    try {
      for (const body of missing) await apiFetch(`/servers/${serverId}/schedules`, { method: 'POST', body: { timezone: zone, ...body } });
      toast.success(t('added'));
    } catch (e) { toast.danger(error(e)); }
    finally { setBusy(false); await reload(); }
  }
  const clash = clashes(list ?? []);
  const duplicate = (list ?? []).some((s) => sameJob(s, { action: f.values.action, time: f.values.time, timezone: zone, days: f.values.days }));

  return <Section title={t('title')} description={t('help', { zone })}
    actions={<span className="flex flex-wrap gap-2">
      {power && <Button size="sm" variant="secondary" isPending={busy} onPress={() => preset([{ action: 'power_on', days: [1, 2, 3, 4, 5], time: '08:00' }, { action: 'shutdown', days: [1, 2, 3, 4, 5], time: '19:00' }])}><I name="briefcase" size={15}/>{t('officeHours')}</Button>}
      {snapshots && <Button size="sm" variant="secondary" isPending={busy} onPress={() => preset([{ action: 'snapshot', days: week, time: '02:00', keep: 3 }])}><I name="camera" size={15}/>{t('nightly')}</Button>}
      {backups && <Button size="sm" variant="secondary" isPending={busy} onPress={() => preset([{ action: 'backup', days: week, time: '03:00', keep: 7 }])}><I name="archive" size={15}/>{t('nightlyBackup')}</Button>}
    </span>}>
    <div className="flex flex-col gap-5">
      {(() => { const n = list && nextRun(list, zone); return n && <p className="flex flex-wrap items-center gap-2 self-start rounded-xl border border-accent/40 bg-accent-soft/40 px-3 py-2 text-sm">
        <I name="alarm-clock" size={15} className="text-accent"/><span className="font-medium">{t('next', { action: t(`action.${n.s.action}`) })}</span>
        <span className="tabular-nums">{format.dateTime(n.at, { weekday: 'long', hour: '2-digit', minute: '2-digit' })}</span>
        <span className="text-muted">({format.relativeTime(n.at)})</span></p>; })()}
      {clash.map((c) => <Notice key={`${c.time}-${c.days.join()}`} tone="warning">{t('clash', { time: c.time, days: daysText(c.days) })}</Notice>)}
      {/* The week at a glance: what runs on each day, in time order. */}
      {list && list.filter((s) => s.enabled).length > 1 && <ol aria-label={t('weekView')} className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {week.map((d) => { const today = ((new Date().getDay() + 6) % 7) + 1 === d; const jobs = list.filter((s) => s.enabled && s.days.includes(d)).sort((a, b) => a.time.localeCompare(b.time));
          return <li key={d} className={`flex min-h-20 flex-col gap-1 rounded-xl border p-2 ${today ? 'border-accent bg-accent-soft/30' : 'border-border'}`}>
            <span className={`text-xs font-semibold uppercase tracking-wide ${today ? 'text-accent' : 'text-muted'}`}>{dayName(d, 'short')}{today && <span className="sr-only"> ({t('today')})</span>}</span>
            {jobs.length ? jobs.map((s) => <span key={s.id} className="flex items-center gap-1.5 text-xs tabular-nums">{icon(s.action)}{s.time}<span className="sr-only"> {t(`action.${s.action}`)}</span></span>)
              : <span className="text-xs text-muted">–</span>}
          </li>; })}
      </ol>}
      {list && list.length > 0 && <ul className="flex flex-col divide-y divide-separator rounded-lg border border-border">
        {list.map((s) => <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
          <span className={`flex items-center gap-2 font-medium ${s.enabled ? '' : 'text-muted'}`}>
            {s.action === 'power_on' ? <I name="sunrise" size={16} className="text-success"/> : s.action === 'snapshot' ? <I name="camera" size={16} className="text-warning"/> : s.action === 'backup' ? <I name="archive" size={16} className="text-success"/> : <I name="moon" size={16} className="text-accent"/>}{t(`action.${s.action}`)}</span>
          <span className="tabular-nums">{s.time}</span>
          <span className="text-sm text-muted">{daysText(s.days)}{s.timezone !== zone && ` · ${s.timezone}`}{(s.action === 'snapshot' || s.action === 'backup') && s.keep && ` · ${t('keeps', { n: s.keep })}`}</span>
          {s.lastResult && <StatusChip tone={s.lastResult === 'started' ? 'success' : s.lastResult === 'failed' ? 'danger' : s.lastResult === 'rotating' ? 'accent' : 'default'}>
            {t(`result.${s.lastResult as 'started'}`)}{s.lastRunAt && <> · <Ago at={s.lastRunAt}/></>}</StatusChip>}
          <span className="ml-auto flex items-center gap-1">
            <SwitchInput isSelected={s.enabled} onChange={() => toggle.mutate(s)} label={<span className="sr-only">{t('enabledFor', { action: t(`action.${s.action}`), time: s.time })}</span>}/>
            <ConfirmButton size="sm" variant="ghost" label={<><I name="trash-2" size={15}/><span className="sr-only">{t('remove', { action: t(`action.${s.action}`), time: s.time })}</span></>}
              title={t('remove', { action: t(`action.${s.action}`), time: s.time })} body={t('removeBody', { days: daysText(s.days) })} confirmLabel={t('removeYes')} cancelLabel={t('cancel')}
              onConfirm={() => remove.mutateAsync(s.id).then(() => undefined)}/>
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
          {(f.values.action === 'snapshot' || f.values.action === 'backup') && <TextInput format="integer" label={t('keep')} value={f.values.keep} onChange={f.set('keep')} error={f.fieldError('keep')} help={t('keepHelp')} autoComplete="off"/>}
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
        {duplicate && <p role="status" className="text-sm text-warning">{t('duplicate')}</p>}
        <div><Button type="submit" isPending={f.busy} isDisabled={duplicate || !f.values.days.length}><I name="calendar-clock" size={15}/>{t('add')}</Button></div>
      </form>
    </div>
  </Section>;
}
