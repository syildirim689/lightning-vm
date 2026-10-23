import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSetupStatus, getUser } from '../../lib/session';
import LocaleSwitcher from '../locale-switcher';
import LogoutButton from './logout-button';
import pkg from '../../package.json';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect((await getSetupStatus()).adminCreated ? '/login' : '/setup');
  const t = await getTranslations('Layout');
  return <><aside><h2>ϟ Lightning VM</h2><small>{t('tagline')}</small>
    <nav><Link href="/">{t('navUser')}</Link>{user.role === 'admin' && <Link href="/admin">{t('navAdmin')}</Link>}</nav>
    <p className="muted">{t('signedInAs', { email: user.email })}</p><LogoutButton/>
    <LocaleSwitcher/><p className="muted">{t('build', { version: pkg.version })}</p></aside>
    <main><div className="notice">{t('notice')}</div>{children}</main></>;
}
