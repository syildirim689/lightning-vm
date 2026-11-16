"use client";
// Ctrl/⌘+K: jump to any page the user may open, any server by name or IP, or run a quick action.
// A combobox with a listbox (arrow keys, Enter, Escape); results are filtered as you type.
import { fold } from '../lib/search';
import { Kbd, Modal, toast } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { setLocale } from '../i18n/actions';
import { signOut } from '../lib/auth-client';
import { can } from '../lib/permissions';
import { useApiQuery, useBillingSummary, useResellerAllocation } from '../lib/query';
import { apiFetch, useErrorText } from '../lib/api';
import { I } from './icon';
import { supports, type Capabilities } from './capabilities';
import { openShortcuts } from './shortcuts';
import { recent } from '../lib/recent';
import { mayLeave } from '../lib/edits';

type Cmd = { id: string; group: 'recent' | 'pages' | 'servers' | 'tickets' | 'users' | 'actions'; label: string; hint?: string; icon: React.ReactNode; run: () => void };
type TicketRow = { id: string; number: number; subject: string; status: 'open' | 'answered' | 'customer_reply' | 'on_hold' | 'closed'; ownerEmail?: string };
type ServerRow = { id: string; name: string; address: string | null; ownerEmail?: string; favorite?: boolean; state: string; powerState: string; deleteAt?: string | null; tags?: string[] | null; capabilities?: Capabilities | null };

export function usePaletteShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}

export default function CommandPalette({ permissions, isOpen, onOpenChange }: { permissions: string[]; isOpen: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useTranslations('Palette');
  const tn = useTranslations('Nav');
  const router = useRouter();
  const locale = useLocale();
  const { resolvedTheme, setTheme } = useTheme();
  const [, start] = useTransition();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const staff = can(permissions, 'servers.view_all');
  const servers = useApiQuery<{ servers: ServerRow[] }>(staff ? ['admin', 'servers'] : ['servers'], isOpen ? (staff ? '/admin/servers' : '/servers') : null).data?.servers ?? [];

  const users = useApiQuery<{ users: { id: string; email: string; name: string }[] }>(['admin', 'users'], isOpen && can(permissions, 'users.view') ? '/admin/users' : null).data?.users ?? [];
  // Tickets: staff search the whole queue, customers their own; "#1001" or the subject finds one.
  const support = can(permissions, 'support.view');
  const tickets = useApiQuery<{ tickets: TicketRow[] }>(support ? ['admin', 'support', 'queue', 'palette'] : ['support', 'mine'], isOpen ? (support ? '/admin/support/tickets?status=' : '/support/tickets') : null).data?.tickets ?? [];
  const ts = useTranslations('Support');
  const go = (href: string) => () => { onOpenChange(false); if (mayLeave(href)) router.push(href); };
  const tsv = useTranslations('Servers');
  const tx = useTranslations('Extras');
  const { error } = useErrorText();
  const mayAct = !staff || can(permissions, 'servers.manage_all');
  // The same gates as the menu: billing while it is switched on, the reseller page for resellers.
  const billing = !!useBillingSummary()?.enabled;
  const reseller = !!useResellerAllocation();
  // A power action straight from the palette (same request and checks as the server page's button).
  const power = (s: ServerRow, action: string) => () => {
    onOpenChange(false);
    apiFetch(`/servers/${s.id}/actions`, { method: 'POST', body: { action }, headers: { 'idempotency-key': crypto.randomUUID() } })
      .then(() => toast.success(t('actionStarted', { name: s.name, action: tsv(`action.${action as 'power_on'}`) })), (e) => toast.danger(error(e)));
  };
  const commands = useMemo<Cmd[]>(() => {
    const pages: [string, string, React.ReactNode, boolean][] = [
      ['/admin', tn('dashboard'), <I key="i" name="layout-dashboard" size={16}/>, can(permissions, 'dashboard.view')],
      ['/admin/stats', tn('stats'), <I key="i" name="chart-line" size={16}/>, can(permissions, 'dashboard.view')],
      ['/admin/servers', tn('servers'), <I key="i" name="server" size={16}/>, can(permissions, 'servers.view_all')],
      ['/admin/vmware', tn('connections'), <I key="i" name="cable" size={16}/>, can(permissions, 'vmware.view', 'vmware.manage')],
      ['/admin/catalog', tn('catalog'), <I key="i" name="boxes" size={16}/>, can(permissions, 'catalog.view', 'catalog.manage')],
      ['/admin/users', tn('users'), <I key="i" name="users" size={16}/>, can(permissions, 'users.view')],
      ['/admin/roles', tn('roles'), <I key="i" name="shield-check" size={16}/>, can(permissions, 'roles.manage', 'users.roles')],
      ['/admin/settings', tn('settings'), <I key="i" name="settings-2" size={16}/>, can(permissions, 'settings.view', 'settings.manage')],
      ['/admin/system', tn('system'), <I key="i" name="activity" size={16}/>, can(permissions, 'system.view')],
      ['/admin/audit', tn('audit'), <I key="i" name="scroll-text" size={16}/>, can(permissions, 'audit.view')],
      ['/admin/terminal', tn('terminal'), <I key="i" name="square-terminal" size={16}/>, can(permissions, 'system.terminal')],
      ['/account?tab=activity', t('activity'), <I key="i" name="history" size={16}/>, true],
      ['/admin/topology', tn('topology'), <I key="i" name="network" size={16}/>, can(permissions, 'dashboard.view', 'servers.view_all')],
      ['/admin/abuse', tn('abuse'), <I key="i" name="shield-alert" size={16}/>, can(permissions, 'servers.view_all')],
      ['/admin/energy', tn('energy'), <I key="i" name="zap" size={16}/>, can(permissions, 'dashboard.view', 'system.view')],
      ['/', tn('myServers'), <I key="i" name="gauge" size={16}/>, true],
      ['/order', tn('newServer'), <I key="i" name="plus" size={16}/>, can(permissions, 'servers.create')],
      ['/firewalls', tn('firewalls'), <I key="i" name="brick-wall-fire" size={16}/>, can(permissions, 'firewalls.manage') || can(permissions, 'servers.view_all')],
      ['/topology', tn('myTopology'), <I key="i" name="waypoints" size={16}/>, true],
      ['/vdc', tn('myVdc'), <I key="i" name="building-2" size={16}/>, true],
      ['/admin/billing', tn('billing'), <I key="i" name="receipt" size={16}/>, can(permissions, 'billing.view')],
      ['/networks', tn('networks'), <I key="i" name="network" size={16}/>, true],
      ['/billing', tn('myBilling'), <I key="i" name="wallet" size={16}/>, billing],
      ['/reseller', tn('reseller'), <I key="i" name="store" size={16}/>, reseller],
      ['/admin/support', tn('support'), <I key="i" name="life-buoy" size={16}/>, support],
      ['/support', tn('mySupport'), <I key="i" name="life-buoy" size={16}/>, true],
      ['/account', tn('account'), <I key="i" name="key-round" size={16}/>, true],
      ['/api-docs', tn('apiDocs'), <I key="i" name="book-open" size={16}/>, true],
      ['/account?tab=notifications', t('notificationSettings'), <I key="i" name="bell" size={16}/>, true],
    ];
    return [
      ...(isOpen ? recent() : []).map((r) => ({ id: `r:${r.href}`, group: 'recent' as const, label: r.label, icon: <I name="history" size={16}/>, run: go(r.href) })),
      ...pages.filter((p) => p[3]).map(([href, label, icon]) => ({ id: `p:${href}`, group: 'pages' as const, label, icon, run: go(href) })),
      ...users.map((u) => ({ id: `u:${u.id}`, group: 'users' as const, label: u.email, hint: u.name, icon: <I name="user" size={16}/>, run: go(`/admin/users?q=${encodeURIComponent(u.email)}`) })),
      // Starred servers first, with their star.
      ...[...servers].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite)).map((s) => ({ id: `s:${s.id}`, group: 'servers' as const, label: s.name, hint: [s.address, s.ownerEmail].filter(Boolean).join(' · '),
        icon: <I name={s.favorite ? 'star' : 'server'} size={16} className={s.favorite ? 'fill-current text-warning' : undefined}/>, run: go(`/servers/${s.id}`) })),
      // Shown only while searching: a server's console and its next power step, without opening its page.
      ...(mayAct ? servers : []).filter((s) => s.state === 'ready' && !s.deleteAt).flatMap((s) => [
        ...(!supports(s, 'console') ? [] : [{ id: `sa:${s.id}:console`, group: 'servers' as const, label: `${s.name}: ${tsv('action.console')}`, hint: s.address ?? undefined, icon: <I name="square-terminal" size={16}/>, run: go(`/servers/${s.id}/console`) }]),
        s.powerState === 'poweredOn'
          ? { id: `sa:${s.id}:shutdown`, group: 'servers' as const, label: `${s.name}: ${tsv('action.shutdown')}`, hint: s.address ?? undefined, icon: <I name="power" size={16}/>, run: power(s, 'shutdown') }
          : { id: `sa:${s.id}:on`, group: 'servers' as const, label: `${s.name}: ${tsv('action.power_on')}`, hint: s.address ?? undefined, icon: <I name="play" size={16}/>, run: power(s, 'power_on') },
      ]),
      // A tag opens the server list filtered to it (found by searching only).
      // Search-only too: the server's SSH command to the clipboard, as on its page.
      ...servers.filter((s) => s.address).map((s) => ({ id: `sc:${s.id}`, group: 'servers' as const, label: t('copySsh', { name: s.name }), hint: `ssh root@${s.address}`,
        icon: <I name="copy" size={16}/>, run: () => { onOpenChange(false); void navigator.clipboard?.writeText(`ssh root@${s.address}`).catch(() => undefined); toast.success(tx('copied', { what: t('sshCopied', { name: s.name }) })); } })),
      ...[...new Set(servers.flatMap((s) => s.tags ?? []))].map((tag) => ({ id: `st:${tag}`, group: 'servers' as const, label: tsv('list.tags.palette', { tag }),
        hint: tsv('list.tags.count', { n: servers.filter((s) => s.tags?.includes(tag)).length }), icon: <I name="tag" size={16}/>, run: go(`${staff ? '/admin/servers' : '/'}?tag=${encodeURIComponent(tag)}`) })),
      // Staff: a customer's e-mail opens the server list filtered to exactly them (found by searching only).
      ...(staff ? [...new Set(servers.map((s) => s.ownerEmail).filter((x): x is string => !!x))] : []).map((email) => ({ id: `so:${email}`, group: 'servers' as const,
        // The count joins the label: a long e-mail would truncate it as a hint on phones.
        label: `${tsv('list.ownerPalette', { email })} · ${tsv('list.tags.count', { n: servers.filter((s) => s.ownerEmail === email).length })}`, icon: <I name="user" size={16}/>,
        run: go(`/admin/servers?owner=${encodeURIComponent(email)}`) })),
      ...tickets.map((x) => ({ id: `t:${x.id}`, group: 'tickets' as const, label: `#${x.number} ${x.subject}`, hint: [ts(`status.${x.status}`), x.ownerEmail].filter(Boolean).join(' · '),
        icon: <I name="life-buoy" size={16}/>, run: go(support ? `/admin/support/${x.id}` : `/support/${x.id}`) })),
      { id: 'a:theme', group: 'actions', label: resolvedTheme === 'dark' ? t('lightTheme') : t('darkTheme'), icon: resolvedTheme === 'dark' ? <I name="sun" size={16}/> : <I name="moon" size={16}/>,
        run: () => { setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'); onOpenChange(false); } },
      { id: 'a:lang', group: 'actions', label: locale === 'tr' ? 'English' : 'Türkçe', icon: <I name="languages" size={16}/>,
        run: () => { onOpenChange(false); start(async () => { const f = new FormData(); f.set('locale', locale === 'tr' ? 'en' : 'tr'); await setLocale(f); router.refresh(); }); } },
      { id: 'a:shortcuts', group: 'actions', label: t('shortcuts'), icon: <I name="keyboard" size={16}/>, run: () => { onOpenChange(false); openShortcuts(); } },
      { id: 'a:logout', group: 'actions', label: tn('logout'), icon: <I name="log-out" size={16}/>, run: () => { onOpenChange(false); void signOut().then(() => window.location.assign('/login')); } },
    ];
  }, [permissions, servers, users, tickets, resolvedTheme, locale, isOpen, billing, reseller]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = fold(query.trim());
  const results = q ? commands.filter((c) => c.group !== 'recent').filter((c) => fold(`${c.label} ${c.hint ?? ''}`).includes(q)) : commands.filter((c) => c.group !== 'tickets' && !/^s[atoc]:/.test(c.id) && ((c.group !== 'servers' && c.group !== 'users') || commands.indexOf(c) < 40));
  useEffect(() => setActive(0), [query, isOpen]);
  useEffect(() => { if (!isOpen) setQuery(''); }, [isOpen]);
  useEffect(() => { listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); results[active]?.run(); }
  };
  const groups = (['recent', 'pages', 'servers', 'tickets', 'users', 'actions'] as const).map((g) => ({ g, items: results.filter((c) => c.group === g) })).filter((x) => x.items.length);

  return <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
    <Modal.Container placement="top" className="pt-[12vh]">
      <Modal.Dialog aria-label={t('title')} className="w-[40rem] max-w-[calc(100vw-1.5rem)] overflow-hidden p-0">
        <div className="flex items-center gap-3 border-b border-separator px-4">
          <I name="search" size={18} className="text-muted"/>
          <input data-palette autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} placeholder={t('placeholder')}
            role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={results[active] ? `${listId}-${results[active].id}` : undefined} aria-label={t('title')}
            className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-muted"/>
          <Kbd>Esc</Kbd>
        </div>
        <ul id={listId} ref={listRef} role="listbox" aria-label={t('title')} className="max-h-[55vh] overflow-y-auto p-2">
          {!results.length && <li className="px-3 py-8 text-center text-sm text-muted">{t('empty', { query })}</li>}
          {groups.map(({ g, items }) => <li key={g} role="presentation">
            <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{t(g)}</p>
            <ul role="presentation">{items.map((c) => {
              const i = results.indexOf(c);
              return <li key={c.id} id={`${listId}-${c.id}`} role="option" aria-selected={i === active} data-index={i} onMouseMove={() => setActive(i)} onClick={() => c.run()}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm ${i === active ? 'bg-accent-soft text-accent-soft-foreground' : ''}`}>
                <span className="shrink-0 text-muted">{c.icon}</span><span className="max-w-[75%] font-medium [overflow-wrap:anywhere]">{c.label}</span>
                {/* The hint only gets the room the label leaves, so a short name never wraps for it. */}
                {c.hint ? <span className="min-w-0 flex-1 truncate text-xs text-muted">{c.hint}</span> : <span className="flex-1"/>}
                {i === active && <I name="corner-down-left" size={14} className="shrink-0 text-muted"/>}
              </li>;
            })}</ul>
          </li>)}
        </ul>
        <div className="flex items-center gap-4 border-t border-separator px-4 py-2 text-xs text-muted">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd>{t('navigate')}</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd>{t('open')}</span>
        </div>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}
