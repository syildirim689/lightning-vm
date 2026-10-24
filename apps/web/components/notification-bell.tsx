"use client";
// The in-app inbox: unread count on the bell, the latest notifications in a popover, a toast when a new one
// arrives while the panel is open. What arrives where is set in Account → Notifications.
import { Button, Popover, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { apiFetch } from '../lib/api';
import { useApiQuery } from '../lib/query';
import { I } from './icon';

type Item = { id: string; event: string; title: string; body: string; link: string | null; createdAt: string; readAt: string | null };

export default function NotificationBell() {
  const t = useTranslations('Inbox');
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const router = useRouter();
  const client = useQueryClient();
  const q = useApiQuery<{ notifications: Item[]; unread: number }>(['notifications'], '/notifications', { refetchInterval: 20_000 });
  const items = q.data?.notifications ?? [];
  const unread = q.data?.unread ?? 0;

  // Toast only for notifications that arrive after the panel loaded.
  const newest = useRef<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const top = items[0];
    if (newest.current !== null && top && top.id !== newest.current && !top.readAt) toast(top.title, { description: top.body });
    newest.current = top?.id ?? '';
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const markRead = async (ids?: string[]) => { await apiFetch('/notifications/read', { method: 'POST', body: ids ? { ids } : {} }); client.invalidateQueries({ queryKey: ['notifications'] }); };
  const label = unread ? t('unreadLabel', { n: unread }) : t('title');

  return <Popover>
    <Button isIconOnly variant="ghost" size="sm" aria-label={label} className="relative">
      <I name="bell" size={18}/>
      <AnimatePresence>{unread > 0 && <motion.span key={unread} initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} aria-hidden
        className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-danger-foreground">{unread > 9 ? '9+' : unread}</motion.span>}</AnimatePresence>
    </Button>
    <Popover.Content placement="bottom end" className="w-[22rem] max-w-[calc(100vw-1.5rem)] p-0">
      <Popover.Dialog className="p-0">
        <div className="flex items-center gap-2 border-b border-separator px-4 py-3">
          <Popover.Heading className="flex-1 text-sm font-semibold">{t('title')}</Popover.Heading>
          {unread > 0 && <Button size="sm" variant="ghost" onPress={() => markRead()}>{t('markAll')}</Button>}
          <NextLink href="/account?tab=notifications" className="text-xs text-accent hover:underline">{t('settings')}</NextLink>
        </div>
        <span className="sr-only" role="status">{label}</span>
        <ul className="max-h-[60vh] divide-y divide-separator overflow-y-auto">
          {items.length === 0 && <li className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted"><I name="bell" size={22}/>{t('empty')}</li>}
          {items.map((n) => <li key={n.id}>
            <button type="button" onClick={() => { void markRead([n.id]); if (n.link) router.push(n.link); }}
              className="flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-default focus-visible:bg-default focus-visible:outline-none">
              <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-accent'}`}/>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={`text-sm ${n.readAt ? '' : 'font-semibold'}`}>{n.title}</span>
                <span className="line-clamp-2 text-xs text-muted">{n.body}</span>
                <span className="text-[11px] text-muted">{format.relativeTime(new Date(n.createdAt), now)}</span>
              </span>
            </button>
          </li>)}
        </ul>
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}
