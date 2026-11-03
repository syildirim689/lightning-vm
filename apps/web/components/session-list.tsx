"use client";
// A person's sessions (theirs on the Security tab, anyone's for staff): device, where from, when it started, was
// last active and ends, and whether a tab has it open right now. Ending one signs that device out at once.
import { Button, Tooltip } from '@heroui/react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { I } from './icon';
import { StatusChip } from './ui';

export type Presence = 'online' | 'recent' | 'offline';
export type SessionRow = { id: string; device: string; mobile: boolean; agent: string; ip: string | null; lastIp: string | null; createdAt: string; lastActiveAt: string; expiresAt: string;
  impersonated: boolean; online: boolean; current: boolean };

// A dot for presence: green and pulsing when online, amber when active in the last 15 minutes, grey otherwise.
export function PresenceDot({ presence, className = '' }: { presence: Presence; className?: string }) {
  const t = useTranslations('Presence');
  const tone = { online: 'bg-success', recent: 'bg-warning', offline: 'bg-default-foreground/30' }[presence];
  return <span role="img" aria-label={t(presence)} title={t(presence)} className={`relative inline-flex size-2.5 shrink-0 ${className}`}>
    {presence === 'online' && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none"/>}
    <span className={`relative inline-flex size-2.5 rounded-full ${tone}`}/>
  </span>;
}

// "Online now", "Active 5 minutes ago", "Last seen 3 days ago", "Never".
export function LastSeen({ presence, at }: { presence: Presence; at: string | null }) {
  const t = useTranslations('Presence');
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  if (presence === 'online') return <span className="font-medium text-success">{t('onlineNow')}</span>;
  if (!at) return <span className="text-muted">{t('never')}</span>;
  const when = format.relativeTime(new Date(Math.min(Date.parse(at), now.getTime())), now);
  return <span className="text-muted" title={format.dateTime(new Date(at), { dateStyle: 'medium', timeStyle: 'short' })}>{presence === 'recent' ? t('activeAgo', { when }) : t('seenAgo', { when })}</span>;
}

export default function SessionList({ sessions, onEnd, canEnd }: { sessions: SessionRow[]; onEnd?: (s: SessionRow) => void; canEnd?: (s: SessionRow) => boolean }) {
  const t = useTranslations('Presence');
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const [list] = useAutoAnimate<HTMLUListElement>();
  const ago = (at: string) => format.relativeTime(new Date(Math.min(Date.parse(at), now.getTime())), now);
  const exact = (at: string) => format.dateTime(new Date(at), { dateStyle: 'medium', timeStyle: 'short' });
  if (!sessions.length) return <p className="text-sm text-muted">{t('noSessions')}</p>;
  return <ul ref={list} className="flex flex-col divide-y divide-separator rounded-xl border border-border">
    {/* This device first, then the ones open now; the API's order (latest activity) within each. */}
    {[...sessions].sort((a, b) => Number(b.current) - Number(a.current) || Number(b.online) - Number(a.online)).map((s) => <li key={s.id} className={`flex flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:gap-3 ${s.current ? 'bg-accent/5' : ''}`}>
      <span className="relative grid size-9 shrink-0 place-items-center rounded-lg bg-default text-muted">
        <I name={s.mobile ? 'smartphone' : 'monitor'} size={16}/>
        <PresenceDot presence={s.online ? 'online' : 'offline'} className="absolute -right-0.5 -top-0.5"/>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <Tooltip delay={300}><Tooltip.Trigger><span className="font-medium">{s.device}</span></Tooltip.Trigger><Tooltip.Content className="max-w-xs break-all text-xs">{s.agent || '–'}</Tooltip.Content></Tooltip>
          {s.current && <StatusChip tone="accent">{t('thisDevice')}</StatusChip>}
          {s.online && <StatusChip tone="success">{t('openNow')}</StatusChip>}
          {s.impersonated && <StatusChip tone="warning">{t('impersonated')}</StatusChip>}
        </span>
        <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
          <span title={exact(s.lastActiveAt)}><I name="activity" size={11} className="mr-1 inline"/>{t('lastActive', { when: ago(s.lastActiveAt) })}</span>
          <span title={exact(s.createdAt)}><I name="log-in" size={11} className="mr-1 inline"/>{t('started', { when: ago(s.createdAt) })}</span>
          <span><I name="globe" size={11} className="mr-1 inline"/>{s.ip && s.lastIp && s.lastIp !== s.ip ? t('ipMoved', { first: s.ip, last: s.lastIp }) : (s.lastIp || s.ip || '–')}</span>
          <span title={exact(s.expiresAt)}><I name="hourglass" size={11} className="mr-1 inline"/>{t('ends', { when: format.relativeTime(new Date(s.expiresAt), now) })}</span>
        </span>
      </span>
      {onEnd && (canEnd?.(s) ?? true) && <Button size="sm" variant="ghost" className="self-start sm:self-center" onPress={() => onEnd(s)}><I name="log-out" size={14}/>{s.current ? t('signOutHere') : t('end')}</Button>}
    </li>)}
  </ul>;
}
