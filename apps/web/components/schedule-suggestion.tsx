"use client";
// The power schedule the panel suggests from a server's usage history (GET /servers/:id/schedule-suggestion): the hours
// it has been idle every week, the two schedules that would keep it off through them, why it is shown and what it
// saves (never money the bill does not show). Nothing is created until the button is pressed, and then by the API
// from its own reading of the history. Without a suggestion one muted line says why not, when the reason is the data.
import { Button } from '@heroui/react';
import { useFormatter, useTranslations } from 'next-intl';
import { apiFetch } from '../lib/api';
import { useApiAction, useApiQuery } from '../lib/query';
import { I } from './icon';

type Advice = { state: 'suggested' | 'not_measured' | 'not_enough_data' | 'scheduled' | 'always_idle' | 'no_window'; timezone: string; days: number; minDays: number; weeks: number;
  kind?: 'nightly' | 'weekly'; offHours?: number; idleHours?: number; schedules?: { action: 'shutdown' | 'power_on'; days: number[]; time: string }[];
  savesMoney: boolean; energyKwhPerWeek: number | null; hidden: boolean };

// The rule's thresholds as the API applies them (apps/api/src/schedule-rules.ts), for the sentence that says why.
const IDLE_AVG = 3, IDLE_MAX = 10;

export function ScheduleSuggestion({ serverId, zone, canPower, onCreated }: { serverId: string; zone: string; canPower: boolean; onCreated: () => void }) {
  const t = useTranslations('ScheduleSuggestion');
  const ts = useTranslations('Schedules');
  const format = useFormatter();
  const key = ['servers', serverId, 'schedule-suggestion'];
  const a = useApiQuery<Advice>(key, `/servers/${serverId}/schedule-suggestion?timezone=${encodeURIComponent(zone)}`, { refetchInterval: 3_600_000 }).data;
  const create = useApiAction(() => apiFetch(`/servers/${serverId}/schedule-suggestion`, { method: 'POST', body: { timezone: zone } }),
    { invalidate: [key, ['insights']], success: t('created'), onSuccess: onCreated });
  const hide = useApiAction(() => apiFetch('/insights/dismissals', { method: 'PUT', body: { key: `schedule:${serverId}`, days: 7 } }), { invalidate: [key, ['insights']], success: t('hidden') });
  if (!a) return null;
  const note = a.state === 'not_measured' ? t('notMeasured') : a.state === 'not_enough_data' ? t('notEnough', { days: a.days, min: a.minDays }) : a.state === 'no_window' ? t('noWindow', { weeks: a.weeks }) : null;
  if (note) return <p data-schedule-suggestion={a.state} className="flex items-start gap-2 text-xs text-muted"><I name="info" size={14} className="mt-0.5 shrink-0"/>{note}</p>;
  if (a.state !== 'suggested' || a.hidden || !a.schedules) return null;
  // Monday 2024-01-01 is ISO weekday 1, so day d is 2024-01-0d.
  const dayName = (d: number) => format.dateTime(new Date(2024, 0, d), { weekday: 'short' });
  const daysText = (days: number[]) => days.length === 7 ? ts('everyDay') : days.join() === '1,2,3,4,5' ? ts('weekdays') : days.join() === '6,7' ? ts('weekend') : days.map(dayName).join(', ');
  const hours = a.offHours ?? 0;
  return <section data-schedule-suggestion="suggested" aria-label={t('title')} className="flex flex-col gap-3 rounded-xl border border-accent/40 bg-accent-soft/30 px-4 py-3">
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-accent"><I name="lightbulb" size={18}/></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{t('title')}: {t(`kind.${a.kind ?? 'nightly'}`)}</p>
        <p className="text-sm text-muted">{t('intro', { weeks: a.weeks, hours })}</p>
      </div>
    </div>
    <ul className="flex flex-col gap-1.5 text-sm">
      {a.schedules.map((s) => <li key={s.action} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {s.action === 'power_on' ? <I name="sunrise" size={15} className="text-success"/> : <I name="moon" size={15} className="text-accent"/>}
        <span className="font-medium">{s.action === 'power_on' ? t('start') : t('shutdown')}</span>
        <span className="tabular-nums">{t('at', { days: daysText(s.days), time: s.time })}</span>
      </li>)}
    </ul>
    <p className="text-xs text-muted">{t('zone', { zone: a.timezone })}</p>
    <p className="text-xs text-muted">{t('why', { days: a.days, idle: a.idleHours ?? 0, avg: IDLE_AVG, max: IDLE_MAX })}</p>
    <p className="text-xs text-muted">{a.savesMoney ? t('money') : t('noMoney')} {a.energyKwhPerWeek !== null ? t('energy', { kwh: format.number(a.energyKwhPerWeek, { maximumFractionDigits: 1 }), hours }) : t('noEnergy', { hours })}</p>
    <div className="flex flex-wrap items-center gap-2">
      {canPower ? <Button size="sm" isPending={create.isPending} onPress={() => create.mutate()}><I name="calendar-plus" size={15}/>{t('create')}</Button> : <span className="text-xs text-muted">{t('noPower')}</span>}
      <Button size="sm" variant="ghost" isPending={hide.isPending} onPress={() => hide.mutate()}><I name="eye-off" size={15}/>{t('notNow')}</Button>
    </div>
  </section>;
}
