"use client";
// The in-app inbox: unread count on the bell, the latest notifications in a popover, a toast when a new one
// arrives while the panel is open. What arrives where is set in Account → Notifications.
// A run of the same news about the same thing (five replies on one ticket) is one row with a count; the row opens
// to show each, and pressing it marks all of them read. The unread badge keeps counting real notifications.
import { Ago } from './ui';
import { Button, Popover, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useLocale, useNow, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { apiFetch, useErrorText } from '../lib/api';
import { useApiQuery } from '../lib/query';
import { I } from './icon';
import { mayLeave } from '../lib/edits';
import { groupRuns } from '../lib/notification-groups';
import { readableNotification, type Say } from '../lib/notification-text';

type Text = { title: string; body: string };
// texts: both languages (newer notifications), so the inbox follows the panel's language.
type Item = Text & { id: string; event: string; link: string | null; createdAt: string; readAt: string | null; texts: { tr: Text; en: Text } | null };
// The kind of a notification is the first part of its event (server.ready → server).
const kindIcons: Record<string, string> = { server: 'server', support: 'life-buoy', auth: 'shield-check', billing: 'wallet', admin: 'activity' };
const kindOf = (n: Pick<Item, 'event'>) => { const k = n.event.split('.')[0]; return k in kindIcons ? k : 'other'; };

// What the inbox needs to say the API's code names in words; shared with "while you were away" (components/away.tsx).
export function useNotificationSay(): Say {
  const t = useTranslations('Inbox');
  const format = useFormatter();
  const ts = useTranslations('Servers');
  const tp = useTranslations('Support');
  const { code } = useErrorText();
  return {
    operation: (k) => (ts.has(`kind.${k}` as 'kind.create') ? ts(`kind.${k}` as 'kind.create') : null),
    failure: (c) => { const text = code(c); return text === c ? null : text; },
    priority: (v) => (tp.has(`priority.${v}` as 'priority.high') ? tp(`priority.${v}` as 'priority.high') : null),
    money: (amount, currency) => format.number(amount, { style: 'currency', currency }),
    operationDone: (name, operation) => t('operationDone', { name, operation }),
    operationFailed: (operation, reason) => t('operationFailed', { operation, reason }),
  };
}

export default function NotificationBell() {
  const t = useTranslations('Inbox');
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const router = useRouter();
  const client = useQueryClient();
  const { error } = useErrorText();

  const q = useApiQuery<{ notifications: Item[]; unread: number }>(['notifications'], '/notifications', { refetchInterval: 120_000 });
  const locale = useLocale() === 'tr' ? 'tr' : 'en';
  // The API's texts, with what they carry as code names said in words (lib/notification-text.ts).
  const say = useNotificationSay();
  const items = (q.data?.notifications ?? []).map((n) => { const text = { ...n, ...n.texts?.[locale] }; return { ...text, ...readableNotification(n.event, text, say) }; });
  const unread = q.data?.unread ?? 0;
  // Only the unread ones, and one kind; both reset when the inbox empties of them.
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [kind, setKind] = useState<string | null>(null);
  const kinds = [...new Set(items.map(kindOf))];
  const shown = items.filter((n) => (!onlyUnread || !n.readAt) && (!kind || kindOf(n) === kind));
  // The row whose single notifications are listed under it (one at a time).
  const [opened, setOpened] = useState<string | null>(null);

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
  const markRead = async (ids?: string[]) => {
    try { await apiFetch('/notifications/read', { method: 'POST', body: ids ? { ids } : {} }); client.invalidateQueries({ queryKey: ['notifications'] }); }
    catch (e) { toast.danger(error(e)); }
  };
  const label = unread ? t('unreadLabel', { n: unread }) : t('title');
  // Runs stay inside their day heading.
  const groups = groupRuns(shown, (n) => dayOf(n.createdAt));
  const go = (ids: string[], link: string | null) => { if (ids.length) void markRead(ids); if (link && mayLeave(link)) router.push(link); };
  const focus = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

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
          {groups.map((g, i) => {
            const n = g.latest, many = g.items.length > 1, isOpen = many && opened === g.key, fresh = g.unread.length > 0;
            return <li key={g.key}>
              {/* Today, yesterday, earlier: a heading where the day changes. */}
              {(i === 0 || dayOf(groups[i - 1].latest.createdAt) !== dayOf(n.createdAt)) && <p className="bg-default/40 px-4 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{t(`day.${dayOf(n.createdAt)}`)}</p>}
              <div className="flex items-stretch">
                {/* One notification: read and opened. A run: every unread one in it is marked read, then its subject opens. */}
                <button type="button" onClick={() => go(many ? g.unread : [n.id], n.link)}
                  className={`flex min-w-0 flex-1 gap-3 px-4 py-3 text-left transition-colors hover:bg-default focus-visible:bg-default ${focus}`}>
                  <span aria-hidden className={`relative mt-0.5 grid size-8 shrink-0 place-items-center rounded-full ${fresh ? 'bg-accent/15 text-accent' : 'bg-default text-muted'}`}>
                    <I name={kindIcons[kindOf(n)] ?? 'bell'} size={15}/>
                    {fresh && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-surface bg-accent"/>}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className={`text-sm ${fresh ? 'font-semibold' : ''}`}>
                      {many && <span className="sr-only">{t('groupCount', { n: g.items.length })} </span>}{n.title}
                      {many && <span aria-hidden className="ml-1.5 inline-grid h-4 min-w-4 place-items-center rounded-full bg-accent/15 px-1 align-[1px] text-[10px] font-semibold leading-none tabular-nums text-accent">{g.items.length}</span>}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted">{n.body}</span>
                    <span className="text-[11px] text-muted"><Ago at={n.createdAt}/></span>
                  </span>
                </button>
                {many && <button type="button" aria-expanded={isOpen} aria-label={t(isOpen ? 'groupHide' : 'groupShow', { n: g.items.length })} onClick={() => setOpened(isOpen ? null : g.key)}
                  className={`grid w-11 shrink-0 place-items-center text-muted transition-colors hover:bg-default hover:text-foreground ${focus}`}>
                  <I name="chevron-down" size={16} className={`transition-transform motion-reduce:transition-none ${isOpen ? 'rotate-180' : ''}`}/></button>}
              </div>
              {isOpen && <ul aria-label={t('groupList', { n: g.items.length })} className="border-t border-separator bg-default/30">
                {g.items.map((x) => <li key={x.id}>
                  <button type="button" onClick={() => go([x.id], x.link)} className={`flex min-h-10 w-full items-baseline gap-2 py-2 pl-[3.75rem] pr-4 text-left text-xs transition-colors hover:bg-default focus-visible:bg-default ${focus}`}>
                    <span aria-hidden className={`size-1.5 shrink-0 -translate-y-px rounded-full ${x.readAt ? 'bg-transparent' : 'bg-accent'}`}/>
                    <span className={`line-clamp-2 min-w-0 flex-1 ${x.readAt ? 'text-muted' : 'font-medium'}`}>{x.body || x.title}{!x.readAt && <span className="sr-only"> ({t('unread')})</span>}</span>
                    <span className="shrink-0 text-[11px] text-muted"><Ago at={x.createdAt}/></span>
                  </button>
                </li>)}
              </ul>}
            </li>;
          })}
        </ul>
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}
