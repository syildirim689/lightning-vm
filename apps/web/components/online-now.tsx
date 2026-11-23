"use client";
// Who is here now (staff with users.view): people with a panel tab open, then those active in the last 15
// minutes, as avatars with their presence; a click opens the user list filtered to them.
import { Avatar, Card, Tooltip } from '@heroui/react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useMe } from '../lib/me';
import { can } from '../lib/permissions';
import { useApiQuery } from '../lib/query';
import { I } from './icon';
import { LastSeen, PresenceDot, type Presence } from './session-list';

type Person = { id: string; email: string; name: string; presence: Presence; lastSeen: string | null };

export default function OnlineNow() {
  const t = useTranslations('Presence');
  const me = useMe();
  const reduce = useReducedMotion();
  const allowed = can(me?.permissions, 'users.view');
  const q = useApiQuery<{ users: Person[] }>(['admin', 'users'], allowed ? '/admin/users' : null, { refetchInterval: 30_000 });
  if (!allowed || !q.data) return null;
  const here = q.data.users.filter((u) => u.presence !== 'offline').sort((a, b) => Number(b.presence === 'online') - Number(a.presence === 'online') || Date.parse(b.lastSeen ?? '0') - Date.parse(a.lastSeen ?? '0'));
  const online = here.filter((u) => u.presence === 'online').length;
  return <Card><Card.Content className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
    <div className="flex items-center gap-3">
      <span className="relative grid size-10 place-items-center rounded-xl bg-success/10 text-success"><I name="radio" size={18}/></span>
      <div><p className="font-semibold">{t('widgetTitle')}</p><p className="text-xs text-muted">{t('widgetCounts', { online, recent: here.length - online })}</p></div>
    </div>
    <ul className="flex flex-1 flex-wrap items-center gap-2" aria-label={t('widgetTitle')}>
      <AnimatePresence initial={false}>
        {here.slice(0, 14).map((u, i) => <motion.li key={u.id} layout initial={reduce ? false : { opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={{ delay: i * 0.03 }}>
          <Tooltip delay={200}>
            <Tooltip.Trigger><span className="relative inline-flex">
              <Avatar size="sm"><Avatar.Fallback>{(u.name || u.email).slice(0, 2).toUpperCase()}</Avatar.Fallback></Avatar>
              <PresenceDot presence={u.presence} className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-surface"/>
            </span></Tooltip.Trigger>
            <Tooltip.Content className="text-xs"><span className="block font-medium">{u.name || u.email}</span><LastSeen presence={u.presence} at={u.lastSeen}/></Tooltip.Content>
          </Tooltip>
        </motion.li>)}
      </AnimatePresence>
      {here.length > 14 && <li className="text-xs text-muted">+{here.length - 14}</li>}
      {!here.length && <li className="text-sm text-muted">{t('nobody')}</li>}
    </ul>
    <NextLink href="/admin/users?status=online" className="inline-flex min-h-6 items-center text-sm text-accent hover:underline">{t('seeAll')}</NextLink>
  </Card.Content></Card>;
}
