"use client";
// The in-app inbox: unread count on the bell, the latest notifications in a popover, a toast when a new one
// arrives while the panel is open. What arrives where is set in Account → Notifications.
import { Ago } from './ui';
import { Button, Popover, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useLocale, useNow, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useApiQuery } from '../lib/query';
import { I } from './icon';
import { mayLeave } from '../lib/edits';

type Text = { title: string; body: string };
// texts: both languages (newer notifications), so the inbox follows the panel's language.
type Item = Text & { id: string; event: string; link: string | null; createdAt: string; readAt: string | null; texts: { tr: Text; en: Text } | null };
// The kind of a notification is the first part of its event (server.ready → server).
const kindIcons: Record<string, string> = { server: 'server', support: 'life-buoy', auth: 'shield-check', billing: 'wallet', admin: 'activity' };
const kindOf = (n: Pick<Item, 'event'>) => { const k = n.event.split('.')[0]; return k in kindIcons ? k : 'other'; };

export default function NotificationBell() {
  const t = useTranslations('Inbox');
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const router = useRouter();
  const client = useQueryClient();
  const q = useApiQuery<{ notifications: Item[]; unread: number }>(['notifications'], '/notifications', { refetchInterval: 20_000 });
  const locale = useLocale() === 'tr' ? 'tr' : 'en';
  const items = (q.data?.notifications ?? []).map((n) => ({ ...n, ...n.texts?.[locale] }));
  const unread = q.data?.unread ?? 0;
  // Only the unread ones, and one kind; both reset when the inbox empties of them.
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [kind, setKind] = useState<string | null>(null);
  const kinds = [...new Set(items.map(kindOf))];
  const shown = items.filter((n) => (!onlyUnread || !n.readAt) && (!kind || kindOf(n) === kind));

  // The unread count leads the tab's title ("(3) Servers"), so a panel left in another tab shows news. Pages set their
  // own title on navigation, so it is put back whenever the title changes.
  useEffect(() => {
    const apply = () => { const bare = document.title.replace(/^\(\d+\+?\) /, ''); const next = unread ? `(${unread > 99 ? '99+' : unread}) ${bare}` : bare; if (document.title !== next) document.title = next; };
    apply();
    const o = new MutationObserver(apply); // the head, not the title node: navigation may replace the node
    o.observe(document.head, { childList: true, characterData: true, subtree: true });
    return () => { o.disconnect(); document.title = document.title.replace(/^\(\d+\+?\) /, ''); };
  }, [unread]);

  // Toast only for notifications that arrive after the panel loaded.
  const newest = useRef<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const top = items[0];
    // A new one with a link offers to open it from the toast.
    if (newest.current !== null && top && top.id !== newest.current && !top.readAt) toast(top.title, { description: top.body,
      ...(top.link && { actionProps: { children: t('open'), size: 'sm' as const, variant: 'secondary' as const, onPress: () => { void markRead([top.id]); if (mayLeave(top.link!)) router.push(top.link!); } } }) });
    newest.current = top?.id ?? '';
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const dayOf = (iso: string) => {
    const d = new Date(iso), start = new Date(now); start.setHours(0, 0, 0, 0);
    return d >= start ? 'today' : d.getTime() >= start.getTime() - 86_400_000 ? 'yesterday' : 'earlier';
  };
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
        {items.length > 0 && <div className="flex flex-col gap-2 border-b border-separator px-4 py-2.5">
          <div role="group" aria-label={t('show')} className="flex rounded-lg bg-default p-0.5 text-xs font-medium">
            {[false, true].map((u) => <button key={String(u)} type="button" aria-pressed={onlyUnread === u} onClick={() => setOnlyUnread(u)}
              className={`flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-accent ${onlyUnread === u ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-foreground'}`}>
              {u ? t('unread') : t('all')}{u && unread > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] leading-4 text-accent-foreground tabular-nums">{unread}</span>}</button>)}
          </div>
          {kinds.length > 1 && <div role="group" aria-label={t('kinds')} className="flex flex-wrap gap-1.5">
            {kinds.map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(kind === k ? null : k)}
              className={`flex min-h-8 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-accent ${kind === k ? 'border-accent bg-accent font-medium text-accent-foreground' : 'border-border text-muted hover:border-accent hover:text-foreground'}`}>
              <I name={kindIcons[k] ?? 'bell'} size={12}/>{t(`kind.${k as 'server'}`)}</button>)}
          </div>}
        </div>}
        <ul className="max-h-[60vh] divide-y divide-separator overflow-y-auto">
          {items.length === 0 && <li className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted"><I name="bell" size={22}/>{t('empty')}</li>}
          {items.length > 0 && shown.length === 0 && <li className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted"><I name="check-check" size={22}/>{onlyUnread && !kind ? t('allRead') : t('noneHere')}</li>}
          {shown.map((n, i) => <li key={n.id}>
            {/* Today, yesterday, earlier: a heading where the day changes. */}
            {(i === 0 || dayOf(shown[i - 1].createdAt) !== dayOf(n.createdAt)) && <p className="bg-default/40 px-4 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{t(`day.${dayOf(n.createdAt)}`)}</p>}
            <button type="button" onClick={() => { void markRead([n.id]); if (n.link && mayLeave(n.link)) router.push(n.link); }}
              className="flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-default focus-visible:bg-default focus-visible:outline-none">
              <span aria-hidden className={`relative mt-0.5 grid size-8 shrink-0 place-items-center rounded-full ${n.readAt ? 'bg-default text-muted' : 'bg-accent/15 text-accent'}`}>
                <I name={kindIcons[kindOf(n)] ?? 'bell'} size={15}/>
                {!n.readAt && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-surface bg-accent"/>}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={`text-sm ${n.readAt ? '' : 'font-semibold'}`}>{n.title}</span>
                <span className="line-clamp-2 text-xs text-muted">{n.body}</span>
                <span className="text-[11px] text-muted"><Ago at={n.createdAt}/></span>
              </span>
            </button>
          </li>)}
        </ul>
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}
