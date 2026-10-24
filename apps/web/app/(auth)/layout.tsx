import { getTranslations } from 'next-intl/server';
import { AccessibilityButton } from '../../components/accessibility';
import { LanguageMenu, ThemeToggle } from '../../components/chrome';
import { Brand } from '../../components/brand';
import { I } from '../../components/icon';
import { getPublicConfig } from '../../lib/session';
import { Points } from './auth-card';
import { AuthScene } from './scene';

// Sign-in, registration and the setup wizard: an animated brand panel on wide screens, the form on the right
// over a slowly drifting background.
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('AuthLayout');
  const { branding } = await getPublicConfig();
  const points = [
    { icon: <I name="rocket" size={16}/>, text: t('points.provision') },
    { icon: <I name="square-terminal" size={16}/>, text: t('points.console') },
    { icon: <I name="gauge" size={16}/>, text: t('points.capacity') },
    { icon: <I name="shield-check" size={16}/>, text: t('points.backup') },
  ];
  return <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
    <aside className="relative hidden overflow-hidden border-r border-separator bg-surface p-10 lg:flex lg:flex-col">
      <div aria-hidden className="auth-grid pointer-events-none absolute inset-0 opacity-60"/>
      <div aria-hidden className="glow pointer-events-none absolute -left-32 -top-32 size-[28rem] rounded-full bg-accent/15 blur-3xl"/>
      <div aria-hidden className="glow pointer-events-none absolute -bottom-40 right-[-8rem] size-[24rem] rounded-full bg-accent/10 blur-3xl" style={{ animationDelay: '300ms' }}/>
      <div className="relative"><Brand branding={branding} href="/login" size="lg"/></div>
      <div className="relative my-auto flex flex-col items-center py-8"><AuthScene/></div>
      <div className="relative flex max-w-md flex-col gap-5">
        <h2 className="rise text-3xl font-semibold leading-tight tracking-tight text-balance">{t('headline')}</h2>
        <p className="rise text-muted" style={{ animationDelay: '120ms' }}>{t('subline')}</p>
        <Points items={points}/>
      </div>
      <p className="relative mt-10 text-xs text-muted">{t('footer')}</p>
    </aside>
    <div className="relative flex flex-col overflow-hidden">
      <div aria-hidden className="auth-aurora pointer-events-none absolute inset-0"/>
      <header className="relative flex items-center justify-between gap-2 px-4 py-3 md:px-8">
        <span className="lg:invisible"><Brand branding={branding} href="/login"/></span>
        <div className="flex items-center gap-1"><AccessibilityButton/><LanguageMenu/><ThemeToggle/></div>
      </header>
      <main className="relative flex flex-1 items-center justify-center px-4 py-8 md:px-8">{children}</main>
    </div>
  </div>;
}
