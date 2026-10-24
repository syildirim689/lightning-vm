"use client";
// Ctrl/⌘+K: jump to any page the user may open, any server by name or IP, or run a quick action.
// A combobox with a listbox (arrow keys, Enter, Escape); results are filtered as you type.
import { Kbd, Modal } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { setLocale } from '../i18n/actions';
import { signOut } from '../lib/auth-client';
import { can } from '../lib/permissions';
import { useApiQuery } from '../lib/query';
import { I } from './icon';
import { openShortcuts } from './shortcuts';

type Cmd = { id: string; group: 'pages' | 'servers' | 'actions'; label: string; hint?: string; icon: React.ReactNode; run: () => void };
type ServerRow = { id: string; name: string; address: string | null; ownerEmail?: string };
const fold = (s: string) => s.toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');

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

  const go = (href: string) => () => { onOpenChange(false); router.push(href); };
  const commands = useMemo<Cmd[]>(() => {
    const pages: [string, string, React.ReactNode, boolean][] = [
      ['/admin', tn('dashboard'), <I key="i" name="layout-dashboard" size={16}/>, can(permissions, 'dashboard.view')],
      ['/admin/servers', tn('servers'), <I key="i" name="server" size={16}/>, can(permissions, 'servers.view_all')],
      ['/admin/vmware', tn('connections'), <I key="i" name="cable" size={16}/>, can(permissions, 'vmware.view', 'vmware.manage')],
      ['/admin/catalog', tn('catalog'), <I key="i" name="boxes" size={16}/>, can(permissions, 'catalog.view', 'catalog.manage')],
      ['/admin/users', tn('users'), <I key="i" name="users" size={16}/>, can(permissions, 'users.view')],
      ['/admin/roles', tn('roles'), <I key="i" name="shield-check" size={16}/>, can(permissions, 'roles.manage', 'users.roles')],
      ['/admin/settings', tn('settings'), <I key="i" name="settings-2" size={16}/>, can(permissions, 'settings.view', 'settings.manage')],
      ['/admin/system', tn('system'), <I key="i" name="activity" size={16}/>, can(permissions, 'system.view')],
      ['/admin/topology', tn('topology'), <I key="i" name="network" size={16}/>, can(permissions, 'dashboard.view', 'servers.view_all')],
      ['/admin/abuse', tn('abuse'), <I key="i" name="shield-alert" size={16}/>, can(permissions, 'servers.view_all')],
      ['/admin/energy', tn('energy'), <I key="i" name="zap" size={16}/>, can(permissions, 'dashboard.view', 'system.view')],
      ['/', tn('myServers'), <I key="i" name="gauge" size={16}/>, true],
      ['/order', tn('newServer'), <I key="i" name="plus" size={16}/>, can(permissions, 'servers.create')],
      ['/firewalls', tn('firewalls'), <I key="i" name="brick-wall-fire" size={16}/>, can(permissions, 'firewalls.manage') || can(permissions, 'servers.view_all')],
      ['/topology', tn('myTopology'), <I key="i" name="waypoints" size={16}/>, true],
      ['/vdc', tn('myVdc'), <I key="i" name="building-2" size={16}/>, true],
      ['/account', tn('account'), <I key="i" name="key-round" size={16}/>, true],
      ['/account?tab=notifications', t('notificationSettings'), <I key="i" name="bell" size={16}/>, true],
    ];
    return [
      ...pages.filter((p) => p[3]).map(([href, label, icon]) => ({ id: `p:${href}`, group: 'pages' as const, label, icon, run: go(href) })),
      ...servers.map((s) => ({ id: `s:${s.id}`, group: 'servers' as const, label: s.name, hint: [s.address, s.ownerEmail].filter(Boolean).join(' · '), icon: <I name="server" size={16}/>, run: go(`/servers/${s.id}`) })),
      { id: 'a:theme', group: 'actions', label: resolvedTheme === 'dark' ? t('lightTheme') : t('darkTheme'), icon: resolvedTheme === 'dark' ? <I name="sun" size={16}/> : <I name="moon" size={16}/>,
        run: () => { setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'); onOpenChange(false); } },
      { id: 'a:lang', group: 'actions', label: locale === 'tr' ? 'English' : 'Türkçe', icon: <I name="languages" size={16}/>,
        run: () => { onOpenChange(false); start(async () => { const f = new FormData(); f.set('locale', locale === 'tr' ? 'en' : 'tr'); await setLocale(f); router.refresh(); }); } },
      { id: 'a:shortcuts', group: 'actions', label: t('shortcuts'), icon: <I name="keyboard" size={16}/>, run: () => { onOpenChange(false); openShortcuts(); } },
      { id: 'a:logout', group: 'actions', label: tn('logout'), icon: <I name="log-out" size={16}/>, run: () => { onOpenChange(false); void signOut().then(() => { router.replace('/login'); router.refresh(); }); } },
    ];
  }, [permissions, servers, resolvedTheme, locale]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = fold(query.trim());
  const results = q ? commands.filter((c) => fold(`${c.label} ${c.hint ?? ''}`).includes(q)) : commands.filter((c) => c.group !== 'servers' || commands.indexOf(c) < 40);
  useEffect(() => setActive(0), [query, isOpen]);
  useEffect(() => { if (!isOpen) setQuery(''); }, [isOpen]);
  useEffect(() => { listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); results[active]?.run(); }
  };
  const groups = (['pages', 'servers', 'actions'] as const).map((g) => ({ g, items: results.filter((c) => c.group === g) })).filter((x) => x.items.length);

  return <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
    <Modal.Container placement="top" className="pt-[12vh]">
      <Modal.Dialog aria-label={t('title')} className="w-[40rem] max-w-[calc(100vw-1.5rem)] overflow-hidden p-0">
        <div className="flex items-center gap-3 border-b border-separator px-4">
          <I name="search" size={18} className="text-muted"/>
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} placeholder={t('placeholder')}
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
                <span className="text-muted">{c.icon}</span><span className="font-medium">{c.label}</span>
                {c.hint && <span className="truncate text-xs text-muted">{c.hint}</span>}
                {i === active && <I name="corner-down-left" size={14} className="ml-auto text-muted"/>}
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
