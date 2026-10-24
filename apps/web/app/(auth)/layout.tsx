import { getTranslations } from 'next-intl/server';
import { LanguageMenu, ThemeToggle } from '../../components/chrome';
import { Brand } from '../../components/brand';
import { I } from '../../components/icon';
import { getPublicConfig } from '../../lib/session';

// Sign-in, registration and the setup wizard: brand panel on wide screens, the form on the right.
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('AuthLayout');
  const { branding } = await getPublicConfig();
  const points = ['provision', 'console', 'capacity', 'backup'] as const;
  const icons = { provision: <I name="rocket" size={16}/>, console: <I name="square-terminal" size={16}/>, capacity: <I name="gauge" size={16}/>, backup: <I name="shield-check" size={16}/> };
  return <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
    <aside className="relative hidden overflow-hidden border-r border-separator bg-surface p-10 lg:flex lg:flex-col">
      <div aria-hidden className="glow pointer-events-none absolute -left-32 -top-32 size-[28rem] rounded-full bg-accent/15 blur-3xl"/>
      <div aria-hidden className="glow pointer-events-none absolute -bottom-40 right-[-8rem] size-[24rem] rounded-full bg-accent/10 blur-3xl" style={{ animationDelay: '300ms' }}/>
      <div className="relative"><Brand branding={branding} href="/login" size="lg"/></div>
      <div className="relative mt-auto flex max-w-md flex-col gap-6">
        <h2 className="rise text-3xl font-semibold leading-tight tracking-tight text-balance">{t('headline')}</h2>
        <p className="text-muted">{t('subline')}</p>
        <ul className="flex flex-col gap-3">
          {points.map((p, i) => <li key={p} className="rise flex items-center gap-3 text-sm" style={{ animationDelay: `${150 + i * 90}ms` }}>
            <span className="grid size-8 place-items-center rounded-lg bg-default text-accent">{icons[p]}</span>{t(`points.${p}`)}
          </li>)}
        </ul>
      </div>
      <p className="relative mt-10 text-xs text-muted">{t('footer')}</p>
    </aside>
    <div className="flex flex-col">
      <header className="flex items-center justify-between gap-2 px-4 py-3 md:px-8">
        <span className="lg:invisible"><Brand branding={branding} href="/login"/></span>
        <div className="flex items-center gap-1"><LanguageMenu/><ThemeToggle/></div>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-8 md:px-8">{children}</main>
    </div>
  </div>;
}
