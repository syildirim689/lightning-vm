"use client";
import ConnectionBanner from '../../components/connection-banner';
import { Avatar, Button, Chip, Drawer, Dropdown, Kbd, Label, Separator } from '@heroui/react';
import { motion } from 'motion/react';
import NextLink from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { Brand } from '../../components/brand';
import { AccessibilityButton } from '../../components/accessibility';
import { LanguageMenu, ThemeToggle } from '../../components/chrome';
import CommandPalette, { usePaletteShortcut } from '../../components/command-palette';
import Shortcuts from '../../components/shortcuts';
import { AnnouncementBar } from '../../components/activity';
import { I } from '../../components/icon';
import LiveEvents from '../../components/live-events';
import SessionExpired from '../../components/session-expired';
import LeaveGuard from '../../components/leave-guard';
import TimeZoneSync from '../../components/time-zone-sync';
import NotificationBell from '../../components/notification-bell';
import TaskManager from '../../components/task-manager';
import { authClient, signOut } from '../../lib/auth-client';
import { can, type Permission } from '../../lib/permissions';
import { useApiQuery } from '../../lib/query';
import type { Branding, User } from '../../lib/session';

type Key = 'dashboard' | 'stats' | 'servers' | 'abuse' | 'energy' | 'topology' | 'myTopology' | 'myVdc' | 'connections' | 'catalog' | 'users' | 'roles' | 'settings' | 'system' | 'myServers' | 'newServer' | 'firewalls' | 'account' | 'audit' | 'terminal' | 'support' | 'mySupport' | 'billing' | 'myBilling' | 'reseller' | 'networks';
// count: a number beside the entry from GET /support/summary (tickets waiting for the customer, or for support).
type Item = { href: string; key: Key; icon: React.ReactNode; exact?: boolean; need?: Permission[]; count?: 'waiting' | 'queue' | 'unpaid'; billing?: boolean; reseller?: boolean };

// Staff entries appear only with a permission that opens them; the API checks every call anyway.
const sections: { title: 'adminSection' | 'peopleSection' | 'customerSection'; items: Item[] }[] = [
  { title: 'adminSection', items: [
    { href: '/admin', key: 'dashboard', icon: <I name="layout-dashboard" size={18}/>, exact: true, need: ['dashboard.view'] },
    { href: '/admin/stats', key: 'stats', icon: <I name="chart-line" size={18}/>, need: ['dashboard.view'] },
    { href: '/admin/servers', key: 'servers', icon: <I name="server" size={18}/>, need: ['servers.view_all'] },
    { href: '/admin/support', key: 'support', icon: <I name="life-buoy" size={18}/>, need: ['support.view'], count: 'queue' },
    { href: '/admin/billing', key: 'billing', icon: <I name="receipt" size={18}/>, need: ['billing.view'] },
    { href: '/admin/topology', key: 'topology', icon: <I name="network" size={18}/>, need: ['dashboard.view', 'servers.view_all'] },
    { href: '/admin/vmware', key: 'connections', icon: <I name="cable" size={18}/>, need: ['vmware.view', 'vmware.manage'] },
    { href: '/admin/catalog', key: 'catalog', icon: <I name="boxes" size={18}/>, need: ['catalog.view', 'catalog.manage'] },
    { href: '/admin/abuse', key: 'abuse', icon: <I name="shield-alert" size={18}/>, need: ['servers.view_all'] },
    { href: '/admin/energy', key: 'energy', icon: <I name="zap" size={18}/>, need: ['dashboard.view', 'system.view'] },
    { href: '/admin/system', key: 'system', icon: <I name="activity" size={18}/>, need: ['system.view'] },
    { href: '/admin/audit', key: 'audit', icon: <I name="scroll-text" size={18}/>, need: ['audit.view'] },
    { href: '/admin/terminal', key: 'terminal', icon: <I name="square-terminal" size={18}/>, need: ['system.terminal'] },
  ] },
  { title: 'peopleSection', items: [
    { href: '/admin/users', key: 'users', icon: <I name="users" size={18}/>, need: ['users.view'] },
    { href: '/admin/roles', key: 'roles', icon: <I name="shield-check" size={18}/>, need: ['roles.manage', 'users.roles'] },
    { href: '/admin/settings', key: 'settings', icon: <I name="settings-2" size={18}/>, need: ['settings.view', 'settings.manage'] },
  ] },
  { title: 'customerSection', items: [
    { href: '/', key: 'myServers', icon: <I name="gauge" size={18}/>, exact: true },
    { href: '/order', key: 'newServer', icon: <I name="plus" size={18}/>, need: ['servers.create'] },
    { href: '/vdc', key: 'myVdc', icon: <I name="building-2" size={18}/> },
    { href: '/topology', key: 'myTopology', icon: <I name="waypoints" size={18}/> },
    { href: '/networks', key: 'networks', icon: <I name="network" size={18}/> },
    { href: '/firewalls', key: 'firewalls', icon: <I name="brick-wall-fire" size={18}/>, need: ['firewalls.manage', 'servers.view_all'] },
    { href: '/billing', key: 'myBilling', icon: <I name="wallet" size={18}/>, count: 'unpaid', billing: true },
    { href: '/reseller', key: 'reseller', icon: <I name="store" size={18}/>, reseller: true },
    { href: '/support', key: 'mySupport', icon: <I name="life-buoy" size={18}/>, count: 'waiting' },
    { href: '/account', key: 'account', icon: <I name="key-round" size={18}/> },
  ] },
];

// Under ['notifications'], so a new notification (a reply, a new ticket) refreshes it too.
function NavCount({ kind }: { kind: 'waiting' | 'queue' | 'unpaid' }) {
  const t = useTranslations('Nav');
  const q = useApiQuery<{ waiting: number; queue: number | null }>(['notifications', 'support-summary'], '/support/summary', { refetchInterval: 60_000 });
  const b = useBillingSummary();
  const n = kind === 'unpaid' ? (b?.open?.n ?? 0) : q.data?.[kind] ?? 0;
  if (!n) return null;
  return <span className="relative ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-foreground">
    {n > 99 ? '99+' : n}<span className="sr-only"> {t(kind === 'waiting' ? 'waitingForYou' : kind === 'unpaid' ? 'unpaidInvoices' : 'waitingForSupport', { n })}</span>
  </span>;
}

// Under ['notifications'] too: a payment or a new invoice refreshes the count.
const useBillingSummary = () => useApiQuery<{ enabled: boolean; open?: { n: number } }>(['notifications', 'billing-summary'], '/billing/summary', { refetchInterval: 60_000 }).data;

function NavList({ user, onNavigate }: { user: User; onNavigate?: () => void }) {
  const t = useTranslations('Nav');
  const billing = useBillingSummary();
  // Shown only to resellers: the summary answers 403 for everyone else.
  const reseller = useApiQuery<{ allocation: object | null }>(['reseller', 'summary'], '/reseller/summary').data?.allocation;
  const path = usePathname();
  const active = (i: Item) => (i.exact ? path === i.href : path === i.href || path.startsWith(`${i.href}/`));
  return <nav aria-label={t('label')} className="flex flex-col gap-3">
    {sections.map((s) => {
      const items = s.items.filter((i) => (!i.need || can(user.permissions, ...i.need)) && (!i.billing || billing?.enabled) && (!i.reseller || !!reseller));
      if (!items.length) return null;
      return <div key={s.title} className="flex flex-col gap-0.5">
        <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{t(s.title)}</p>
        {items.map((i) => <NextLink key={i.href} href={i.href} onClick={onNavigate} aria-current={active(i) ? 'page' : undefined}
          className={`relative flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors duration-150 ${active(i) ? 'text-accent-soft-foreground' : 'text-muted hover:bg-default hover:text-foreground'}`}>
          {/* The highlight slides between entries instead of jumping. */}
          {active(i) && <motion.span layoutId={onNavigate ? 'nav-active-drawer' : 'nav-active'} className="absolute inset-0 rounded-lg bg-accent-soft" transition={{ type: 'spring', stiffness: 500, damping: 38 }}/>}
          <span aria-hidden className="relative">{i.icon}</span><span className="relative">{t(i.key)}</span>
          {i.count && <NavCount kind={i.count}/>}
        </NextLink>)}
      </div>;
    })}
  </nav>;
}

function UserMenu({ user }: { user: User }) {
  const t = useTranslations('Nav');
  const router = useRouter();
  const out = async () => { await signOut(); router.replace('/login'); router.refresh(); };
  const initials = (user.name || user.email.split('@')[0]).split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  return <Dropdown>
    <Button variant="ghost" size="sm" aria-label={t('userMenu')} className="gap-2">
      <Avatar size="sm" color="accent"><Avatar.Fallback>{initials}</Avatar.Fallback></Avatar>
      <span className="hidden max-w-48 truncate text-sm lg:inline">{user.name || user.email}</span>
    </Button>
    <Dropdown.Popover placement="bottom end">
      <Dropdown.Menu aria-label={t('userMenu')} onAction={(k) => { if (k === 'logout') void out(); else router.push(String(k)); }}>
        <Dropdown.Item id="/account" textValue={t('account')}><I name="key-round" size={16}/><Label>{t('account')}</Label></Dropdown.Item>
        <Dropdown.Item id="/account?tab=notifications" textValue={t('notifications')}><I name="bell" size={16}/><Label>{t('notifications')}</Label></Dropdown.Item>
        <Dropdown.Item id="logout" textValue={t('logout')} variant="danger"><I name="log-out" size={16}/><Label>{t('logout')}</Label></Dropdown.Item>
      </Dropdown.Menu>
    </Dropdown.Popover>
  </Dropdown>;
}

// Shown while a staff member is signed in as this user; one click returns to their own account.
function ImpersonationBanner({ user }: { user: User }) {
  const t = useTranslations('Nav');
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!user.impersonatedBy) return null;
  return <div role="status" className="flex flex-wrap items-center justify-center gap-3 bg-warning px-4 py-2 text-sm font-medium text-warning-foreground">
    <I name="user-round-cog" size={16}/>{t('impersonating', { email: user.email })}
    <Button size="sm" variant="tertiary" isPending={busy} onPress={async () => { setBusy(true); await authClient.admin.stopImpersonating(); router.replace('/admin/users'); router.refresh(); }}>{t('stopImpersonating')}</Button>
  </div>;
}

export default function Shell({ user, branding, version, children }: { user: User; branding: Branding; version: string; children: React.ReactNode }) {
  const t = useTranslations('Nav');
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  usePaletteShortcut(useCallback(() => setPalette(true), []));
  const roleLabel = user.permissions.includes('*') ? t('adminBadge') : user.roles.filter((r) => r !== 'user').length ? t('staffBadge') : null;
  const footer = <div className="mt-auto flex flex-col gap-2 px-3 pt-4 text-xs text-muted">
    <Separator/>
    <div className="flex items-center justify-between"><span>v{version}</span><Chip size="sm" variant="soft" color="warning">{t('earlyBuild')}</Chip></div>
  </div>;
  const home = can(user.permissions, 'dashboard.view') ? '/admin' : '/';
  return <div className="flex min-h-dvh flex-col">
    <LiveEvents/>
    <SessionExpired/>
    <LeaveGuard/>
    <TimeZoneSync/>
    <ImpersonationBanner user={user}/>
    <AnnouncementBar/>
    <div className="flex min-h-0 flex-1">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-separator bg-surface px-3 py-5 lg:flex">
        <Brand branding={branding} href={home}/>
        <NavList user={user}/>
        {footer}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-1 border-b border-separator bg-background/85 px-3 backdrop-blur sm:gap-2 md:px-6">
          <Drawer>
            <Button isIconOnly variant="ghost" size="sm" aria-label={t('openMenu')} className="lg:hidden" onPress={() => setOpen(true)}><I name="menu" size={20}/></Button>
            <Drawer.Backdrop isOpen={open} onOpenChange={setOpen}>
              <Drawer.Content placement="left">
                <Drawer.Dialog aria-label={t('label')} className="w-72 max-w-[85vw]">
                  <Drawer.CloseTrigger/>
                  <Drawer.Body className="flex flex-col gap-4 py-4"><Brand branding={branding} href={home}/><NavList user={user} onNavigate={() => setOpen(false)}/>{footer}</Drawer.Body>
                </Drawer.Dialog>
              </Drawer.Content>
            </Drawer.Backdrop>
          </Drawer>
          <div className="min-w-0 lg:hidden"><Brand branding={branding} href={home}/></div>
          <button type="button" onClick={() => setPalette(true)} aria-label={t('search')}
            className="ml-auto hidden h-9 min-w-0 shrink items-center gap-2 rounded-lg border border-border bg-default/50 px-3 text-sm text-muted transition-colors hover:border-accent md:flex md:w-48 lg:ml-0 lg:w-auto lg:min-w-56">
            {/* One line at every width: the text shortens and the key hint goes on narrow headers (tablets). */}
            <I name="search" size={16} className="shrink-0"/><span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">{t('search')}</span><span className="hidden shrink-0 gap-0.5 lg:flex"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
          </button>
          <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
            <Button isIconOnly variant="ghost" size="sm" aria-label={t('search')} className="md:hidden" onPress={() => setPalette(true)}><I name="search" size={18}/></Button>
            {roleLabel && <Chip size="sm" variant="soft" color="accent" className="mr-1 hidden xl:inline-flex">{roleLabel}</Chip>}
            <NotificationBell/>
            <span className="hidden sm:contents"><AccessibilityButton/><LanguageMenu/><ThemeToggle/></span>
            <UserMenu user={user}/>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[150rem] flex-1 px-4 py-6 pb-24 md:px-8 md:py-8 2xl:px-10">
          {/* Each page fades in; no exit animation, so navigation never waits on it. */}
          <motion.div key={path} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: 'easeOut' }}>{children}</motion.div>
        </main>
      </div>
    </div>
    <ConnectionBanner/>
    <TaskManager permissions={user.permissions}/>
    <CommandPalette permissions={user.permissions} isOpen={palette} onOpenChange={setPalette}/>
    <Shortcuts permissions={user.permissions}/>
  </div>;
}
