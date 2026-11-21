"use client";
// The quietest hours the panel works out from the servers' usage history (apps/api/src/maintenance-hours.ts), shown
// where staff plan work that disturbs servers: under the automatic update window (GET /admin/maintenance/quiet-hours,
// in the panel server's own time zone, with a button that asks for that window through the ordinary request) and on
// a connection's hosts (GET /admin/vmware/connections/:id/quiet-hours, in the viewer's zone, to pick the hour before
// emptying a host). Every line says the numbers it rests on; without enough history, or on a platform that reports no
// CPU figures, one muted line says so and nothing is offered.
import { Button } from '@heroui/react';
import { useFormatter, useTranslations } from 'next-intl';
import { useApiQuery } from '../lib/query';
import { I } from './icon';

type Stretch = { day: number; time: string; end: string; hours: number; load: number };
export type QuietAdvice = { state: 'suggested' | 'not_measured' | 'not_enough_data'; days: number; minDays: number; weeks: number;
  servers?: number; usual?: number; peak?: number; weekly?: Stretch | null; daily?: (Stretch & { worst: number }) | null };
type Panel = QuietAdvice & { timezone: string; zoneKnown: boolean; window: string | null; current: string | null };
type Connection = { timezone: string; connection: QuietAdvice; hosts: (QuietAdvice & { moref: string; name: string })[] };

function useWords() {
  const t = useTranslations('QuietHours');
  const format = useFormatter();
  const n = (x: number | undefined) => format.number(x ?? 0, { maximumFractionDigits: 2 });
  // Monday 2024-01-01 is ISO weekday 1, so day d is 2024-01-0d.
  const dayName = (d: number) => format.dateTime(new Date(2024, 0, d), { weekday: 'long' });
  const numbers = (a: QuietAdvice) => (a.daily ? t('daily', { from: a.daily.time, to: a.daily.end, load: n(a.daily.load), usual: n(a.usual), peak: n(a.peak), worst: n(a.daily.worst) }) : '');
  const week = (a: QuietAdvice) => (a.weekly ? t('weekly', { day: dayName(a.weekly.day), from: a.weekly.time, to: a.weekly.end, load: n(a.weekly.load) }) : '');
  const none = (a: QuietAdvice) => (a.state === 'not_measured' ? t('notMeasured') : a.state === 'not_enough_data' ? t('notEnough', { days: a.days, min: a.minDays }) : null);
  return { t, numbers, week, none };
}

// Under the automatic update window. onUse: asks for the suggested window through the page's own request.
export function UpdateWindowSuggestion({ canApply, onUse }: { canApply: boolean; onUse: (window: string) => void }) {
  const { t, numbers, week, none } = useWords();
  const a = useApiQuery<Panel>(['admin', 'maintenance', 'quiet-hours'], '/admin/maintenance/quiet-hours', { refetchInterval: 1_800_000 }).data;
  if (!a) return null;
  const why = none(a);
  if (why) return <p data-quiet-hours={a.state} className="flex items-start gap-2 text-xs text-muted"><I name="info" size={14} className="mt-0.5 shrink-0"/>{t('window')}: {why}</p>;
  const same = !!a.window && a.window === a.current;
  return <section data-quiet-hours="suggested" aria-label={t('window')} className="flex flex-col gap-2 rounded-xl border border-accent/40 bg-accent-soft/30 px-4 py-3">
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-accent"><I name="lightbulb" size={18}/></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{t('window')}{a.daily ? `: ${a.daily.time}–${a.daily.end}` : ''}</p>
        <p className="text-sm text-muted">{t('basis', { weeks: a.weeks, days: a.days, servers: a.servers ?? 0 })} {numbers(a)}</p>
      </div>
    </div>
    {a.weekly && <p className="text-xs text-muted">{week(a)}</p>}
    <p className="text-xs text-muted">{a.zoneKnown ? t('zone', { zone: a.timezone }) : t('zoneUnknown')} {t('meaning')}</p>
    {a.window && a.zoneKnown && (same ? <p className="text-xs font-medium text-success">{t('same')}</p>
      : canApply && <div><Button size="sm" variant="secondary" onPress={() => onUse(a.window!)}><I name="calendar-clock" size={15}/>{t('use', { window: a.window.replace('-', '–') })}</Button></div>)}
  </section>;
}

// On a connection's hosts tab: the connection as a whole, then each host that runs panel servers.
export function ConnectionQuietHours({ connectionId }: { connectionId: string }) {
  const { t, numbers, week, none } = useWords();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const d = useApiQuery<Connection>(['admin', 'vmware', connectionId, 'quiet-hours'], `/admin/vmware/connections/${connectionId}/quiet-hours?timezone=${encodeURIComponent(zone)}`, { refetchInterval: 1_800_000 }).data;
  if (!d) return null;
  const why = none(d.connection);
  if (why) return <p data-quiet-hours={d.connection.state} className="mb-3 flex items-start gap-2 text-xs text-muted"><I name="info" size={14} className="mt-0.5 shrink-0"/>{t('maintenance')}: {why}</p>;
  const a = d.connection;
  return <section data-quiet-hours="suggested" aria-label={t('maintenance')} className="mb-4 flex flex-col gap-2 rounded-xl border border-border px-4 py-3">
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-accent"><I name="lightbulb" size={18}/></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{t('maintenance')}{a.daily ? `: ${a.daily.time}–${a.daily.end}` : ''}</p>
        <p className="text-sm text-muted">{t('basis', { weeks: a.weeks, days: a.days, servers: a.servers ?? 0 })} {numbers(a)}</p>
      </div>
    </div>
    {a.weekly && <p className="text-xs text-muted">{week(a)}</p>}
    {d.hosts.length > 0 && <ul className="flex flex-col gap-1 text-sm">
      {d.hosts.map((h) => <li key={h.moref} data-quiet-host={h.name} className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{h.name}</span>
        <span className="text-muted">{none(h) ?? `${t('host', { servers: h.servers ?? 0 })} ${numbers(h)} ${week(h)}`}</span>
      </li>)}
    </ul>}
    <p className="text-xs text-muted">{t('zone', { zone: d.timezone })} {t('meaning')} {t('onlySuggests')}</p>
  </section>;
}
