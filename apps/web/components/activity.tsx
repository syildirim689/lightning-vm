"use client";
// Audit events in words (known actions are translated, others shown as their code), the user's own activity
// timeline, and the admin's announcement bar on every signed-in page.
import { Button, toast } from '@heroui/react';
import NextLink from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiFetch, useErrorText } from '../lib/api';
import { useMe } from '../lib/me';
import { useApiQuery } from '../lib/query';
import { I } from './icon';
import { StatusChip, Loading } from './ui';

export type AuditEvent = { id: string; at: string; action: string; outcome: 'success' | 'failure' | 'denied'; ip: string | null; metadata: Record<string, unknown>; actorEmail: string | null; actorName?: string | null; actorId: string | null };

export function useActionLabel() {
  const t = useTranslations('Activity');
  // A translated label for known actions ("auth.login" → actions.auth_login), else the raw code.
  return (action: string) => {
    const k = `actions.${action.replace(/\./g, '_')}` as 'actions.auth_login';
    if (t.has(k)) return t(k);
    // Actions with a variable tail: setup.step.<step>, admin.user.<action>.
    const m = /^(setup\.step|admin\.user)\.(.+)$/.exec(action);
    return m ? t(`prefixed.${m[1].replace('.', '_') as 'setup_step'}`, { name: m[2].replace(/[-_]/g, ' ') }) : action;
  };
}

export const outcomeTone = { success: 'success', failure: 'danger', denied: 'warning' } as const;

export function ActivityIcon({ action }: { action: string }) {
  const c = action.split('.')[0];
  return <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-default text-muted">
    {c === 'auth' ? <I name="log-in" size={15}/> : c === 'server' ? <I name="server" size={15}/> : c === 'settings' ? <I name="settings-2" size={15}/> : c === 'firewall' ? <I name="brick-wall-fire" size={15}/>
      : c === 'admin' ? <I name="user-cog" size={15}/> : <I name="activity" size={15}/>}
  </span>;
}

// The signed-in user's own events, newest first, 50 per page.
export function MyActivity() {
  const t = useTranslations('Activity');
  const format = useFormatter();
  const label = useActionLabel();
  const { error } = useErrorText();
  const me = useMe();
  const first = useApiQuery<{ events: AuditEvent[]; nextBefore: string | null }>(['activity'], '/activity').data;
  const [extra, setExtra] = useState<AuditEvent[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (!first) return <Loading of={['activity']}/>;
  const events = [...first.events, ...extra];
  const cursor = next === undefined ? first.nextBefore : next;
  if (!events.length) return <p className="text-sm text-muted">{t('empty')}</p>;
  // Events somebody else recorded for this account (the API marks them: metadata.forOwner). Their reseller is named
  // (actingAs, with the address the API gives for it alone); staff taking the account out of a reseller's hands is
  // said as support, without a name.
  const doneBy = (e: AuditEvent) => (!me || !e.actorId || e.actorId === me.id ? null : e.metadata?.actingAs === 'reseller' ? 'byReseller' as const
    : e.metadata?.by === 'staff' ? 'bySupport' as const : null);
  return <div className="flex flex-col gap-3">
    <ol className="flex flex-col">
      {events.map((e) => <li key={e.id} className="flex gap-3 border-b border-separator py-2.5 last:border-0">
        <ActivityIcon action={e.action}/>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">{label(e.action)}
            {e.outcome !== 'success' && <StatusChip tone={outcomeTone[e.outcome]}>{t(`outcome.${e.outcome}`)}</StatusChip>}
            {!e.actorId && <StatusChip tone="accent">{t('bySchedule')}</StatusChip>}
            {doneBy(e) && <StatusChip tone="warning">{t(doneBy(e)!)}</StatusChip>}</span>
          <span className="text-xs text-muted">
            <time dateTime={e.at} title={format.dateTime(new Date(e.at), { dateStyle: 'medium', timeStyle: 'medium' })}>{format.relativeTime(new Date(e.at))}</time>
            {e.ip && <> · {e.ip}</>}{doneBy(e) === 'byReseller' && (e.actorName || e.actorEmail) && <> · {e.actorName || e.actorEmail}</>}</span>
        </div>
      </li>)}
    </ol>
    {cursor && <div><Button variant="secondary" size="sm" isPending={busy} onPress={async () => {
      setBusy(true);
      try { const r = await apiFetch<{ events: AuditEvent[]; nextBefore: string | null }>(`/activity?before=${cursor}`); setExtra((x) => [...x, ...r.events]); setNext(r.nextBefore); }
      catch (e) { toast.danger(error(e)); }
      finally { setBusy(false); }
    }}><I name="chevrons-down" size={15}/>{t('more')}</Button></div>}
  </div>;
}

type Announcement = { id: string; tone: 'info' | 'warning' | 'danger' | 'success'; textTr: string; textEn: string; link: string; endsAt: string | null };
const KEY = 'lvm-announcement-closed';

export function AnnouncementBar() {
  const t = useTranslations('Activity');
  const locale = useLocale();
  const format = useFormatter();
  const q = useApiQuery<{ announcement: Announcement | null; incident: { id: string; title: string; impact: string; status: string } | null }>(['announcement'], '/announcement', { refetchInterval: 120_000 });
  const a = q.data?.announcement;
  const incident = q.data?.incident;
  const [closed, setClosed] = useState<string | null>(null);
  useEffect(() => { try { setClosed(localStorage.getItem(KEY)); } catch { /* storage blocked */ } }, []);
  const incidentBar = incident && <div role="status" className={`flex items-center gap-3 px-4 py-2 text-sm md:px-6 ${incident.impact === 'major' ? 'bg-danger text-danger-foreground' : 'bg-warning text-warning-foreground'}`}>
    <span aria-hidden className="relative flex size-2.5 shrink-0"><span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60"/><span className="relative inline-flex size-2.5 rounded-full bg-current"/></span>
    <p className="min-w-0 flex-1"><span className="font-medium">{incident.title}</span><span className="opacity-80"> · {t(`incident.${incident.status as 'investigating'}`)}</span></p>
    <NextLink href="/status" className="shrink-0 font-semibold underline underline-offset-2">{t('incident.details')}</NextLink>
  </div>;
  if (!a || closed === a.id) return incidentBar || null;
  const text = (locale === 'tr' ? a.textTr || a.textEn : a.textEn || a.textTr);
  const tone = { info: 'bg-accent-soft text-accent-soft-foreground', warning: 'bg-warning text-warning-foreground', danger: 'bg-danger text-danger-foreground', success: 'bg-success text-success-foreground' }[a.tone];
  return <>{incidentBar}<div role="status" className={`flex items-start gap-3 px-4 py-2 text-sm md:items-center md:px-6 ${tone}`}>
    <span className="mt-0.5 shrink-0 md:mt-0">{a.tone === 'danger' || a.tone === 'warning' ? <I name="triangle-alert" size={16}/> : <I name="megaphone" size={16}/>}</span>
    <p className="min-w-0 flex-1">
      <span className="font-medium">{text}</span>
      {a.endsAt && <span className="opacity-80"> · {t('until', { time: format.dateTime(new Date(a.endsAt), { dateStyle: 'medium', timeStyle: 'short' }) })}</span>}
      {a.link && <> · <NextLink href={a.link} className="font-semibold underline underline-offset-2">{t('details')}</NextLink></>}
    </p>
    <button type="button" aria-label={t('close')} className="-my-1 grid size-9 shrink-0 place-items-center rounded-md hover:bg-black/10"
      onClick={() => { setClosed(a.id); try { localStorage.setItem(KEY, a.id); } catch { /* storage blocked */ } }}><I name="x" size={16}/></button>
  </div></>;
}
