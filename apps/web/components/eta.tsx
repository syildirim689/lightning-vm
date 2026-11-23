"use client";
// "Usually about 2 minutes" beside a running operation, from this panel's own history (lib/eta.ts), and a calm
// "taking longer than usual" once it is well past that. Nothing is shown without enough history. One read per
// ten minutes at most, shared by the task list and the server page; no polling of its own.
import { useTranslations } from 'next-intl';
import { isLate, pickEstimate, spoken, type Estimates } from '../lib/eta';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

export function useEstimates() {
  // An API without the route (older version) simply has no estimates: no retry, nothing shown.
  return useQuery<{ estimates: Estimates }>({ queryKey: ['tasks', 'estimates'], queryFn: ({ signal }) => apiFetch('/operations/estimates', { signal }), staleTime: 600_000, retry: false }).data?.estimates;
}

export function useSpoken() {
  const t = useTranslations('Eta');
  return (seconds: number) => { const s = spoken(seconds); return s.unit === 'under' ? t('under') : t(s.unit, { n: s.n }); };
}

// One line: the usual time, or that it is taking longer; `basis` adds what the figure is based on (the server page),
// otherwise it is in the title (the compact task list).
export function EtaLine({ kind, diskGb, elapsed, basis, className = '' }: { kind: string; diskGb?: number | null; elapsed: number; basis?: boolean; className?: string }) {
  const t = useTranslations('Eta');
  const ts = useTranslations('Servers');
  const say = useSpoken();
  const picked = pickEstimate(useEstimates(), kind, diskGb);
  if (!picked) return null;
  const { e, sized } = picked;
  const late = isLate(e, elapsed);
  const why = t('basis', { n: e.n, kind: ts(`kind.${kind as 'create'}`), sized: String(sized) });
  return <span className={`${late ? 'text-warning' : 'text-muted'} ${className}`} title={basis ? undefined : why} data-eta={late ? 'late' : 'usual'}>
    {t(late ? 'late' : 'usual', { time: say(e.median) })}
    {basis && <span className="block text-xs text-muted">{why}</span>}
  </span>;
}
