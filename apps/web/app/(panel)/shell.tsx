"use client";
import { Avatar, Button, Chip, Drawer, Dropdown, Label, Separator } from '@heroui/react';
import { I } from '../../components/icon';
import NextLink from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { signOut } from '../../lib/auth-client';
import { LanguageMenu, ThemeToggle } from '../../components/chrome';

type User = { email: string; role: 'admin' | 'user' };
type Item = { href: string; key: 'dashboard' | 'servers' | 'connections' | 'catalog' | 'system' | 'myServers' | 'newServer' | 'account'; icon: React.ReactNode; exact?: boolean };

const adminItems: Item[] = [
  { href: '/admin', key: 'dashboard', icon: <I name="layout-dashboard" size={18}/>, exact: true },
  { href: '/admin/servers', key: 'servers', icon: <I name="server" size={18}/> },
  { href: '/admin/vmware', key: 'connections', icon: <I name="cable" size={18}/> },
  { href: '/admin/catalog', key: 'catalog', icon: <I name="boxes" size={18}/> },
  { href: '/admin/system', key: 'system', icon: <I name="settings-2" size={18}/> },
];
const customerItems: Item[] = [
  { href: '/', key: 'myServers', icon: <I name="gauge" size={18}/>, exact: true },
  { href: '/order', key: 'newServer', icon: <I name="plus" size={18}/> },
  { href: '/account', key: 'account', icon: <I name="key-round" size={18}/> },
];

function NavList({ user, onNavigate }: { user: User; onNavigate?: () => void }) {
  const t = useTranslations('Nav');
  const path = usePathname();
  const active = (i: Item) => (i.exact ? path === i.href : path === i.href || path.startsWith(`${i.href}/`));
  const group = (title: string, items: Item[]) => <div className="flex flex-col gap-0.5">
    <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</p>
    {items.map((i) => <NextLink key={i.href} href={i.href} onClick={onNavigate} aria-current={active(i) ? 'page' : undefined}
      className={`flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors duration-150 ${active(i) ? 'bg-accent-soft text-accent-soft-foreground' : 'text-muted hover:bg-default hover:text-foreground'}`}>
      <span aria-hidden>{i.icon}</span>{t(i.key)}
    </NextLink>)}
  </div>;
  return <nav aria-label={t('label')} className="flex flex-col gap-2">
    {user.role === 'admin' && group(t('adminSection'), adminItems)}
    {group(t('customerSection'), customerItems)}
  </nav>;
}

function Brand() {
  return <NextLink href="/" className="flex items-center gap-2 px-3 py-1">
    <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-accent text-accent-foreground"><I name="zap" size={18}/></span>
    <span className="text-[15px] font-semibold tracking-tight">Lightning VM</span>
  </NextLink>;
}

function UserMenu({ user }: { user: User }) {
  const t = useTranslations('Nav');
  const router = useRouter();
  const out = async () => { await signOut(); router.replace('/login'); router.refresh(); };
  return <Dropdown>
    <Button variant="ghost" size="sm" aria-label={t('userMenu')} className="gap-2">
      <Avatar size="sm" color="accent"><Avatar.Fallback>{user.email.slice(0, 2).toUpperCase()}</Avatar.Fallback></Avatar>
      <span className="hidden max-w-48 truncate text-sm md:inline">{user.email}</span>
    </Button>
    <Dropdown.Popover placement="bottom end">
      <Dropdown.Menu aria-label={t('userMenu')} onAction={(k) => { if (k === 'logout') void out(); else router.push('/account'); }}>
        <Dropdown.Item id="account" textValue={t('account')}><Label>{t('account')}</Label></Dropdown.Item>
        <Dropdown.Item id="logout" textValue={t('logout')} variant="danger"><I name="log-out" size={16}/><Label>{t('logout')}</Label></Dropdown.Item>
      </Dropdown.Menu>
    </Dropdown.Popover>
  </Dropdown>;
}

export default function Shell({ user, version, children }: { user: User; version: string; children: React.ReactNode }) {
  const t = useTranslations('Nav');
  const [open, setOpen] = useState(false);
  const footer = <div className="mt-auto flex flex-col gap-2 px-3 pt-4 text-xs text-muted">
    <Separator/>
    <div className="flex items-center justify-between">
      <span>v{version}</span>
      <Chip size="sm" variant="soft" color="warning">{t('earlyBuild')}</Chip>
    </div>
  </div>;
  return <div className="flex min-h-dvh">
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-4 border-r border-separator bg-surface px-3 py-5 lg:flex">
      <Brand/>
      <NavList user={user}/>
      {footer}
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-separator bg-background/85 px-4 backdrop-blur md:px-6">
        <Drawer>
          <Button isIconOnly variant="ghost" size="sm" aria-label={t('openMenu')} className="lg:hidden" onPress={() => setOpen(true)}><I name="menu" size={20}/></Button>
          <Drawer.Backdrop isOpen={open} onOpenChange={setOpen}>
            <Drawer.Content placement="left">
              <Drawer.Dialog aria-label={t('label')} className="w-72">
                <Drawer.CloseTrigger/>
                <Drawer.Body className="flex flex-col gap-4 py-4"><Brand/><NavList user={user} onNavigate={() => setOpen(false)}/>{footer}</Drawer.Body>
              </Drawer.Dialog>
            </Drawer.Content>
          </Drawer.Backdrop>
        </Drawer>
        <div className="lg:hidden"><Brand/></div>
        <div className="ml-auto flex items-center gap-1">
          {user.role === 'admin' && <Chip size="sm" variant="soft" color="accent" className="mr-1 hidden sm:inline-flex">{t('adminBadge')}</Chip>}
          <LanguageMenu/>
          <ThemeToggle/>
          <UserMenu user={user}/>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  </div>;
}
