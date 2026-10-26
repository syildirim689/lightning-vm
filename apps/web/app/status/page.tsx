import { getTranslations } from 'next-intl/server';
import { Brand } from '../../components/brand';
import { AccessibilityButton } from '../../components/accessibility';
import { LanguageMenu, ThemeToggle } from '../../components/chrome';
import { getPublicConfig } from '../../lib/session';
import StatusView from './status-view';

export async function generateMetadata() {
  const t = await getTranslations('PublicStatus');
  return { title: t('title') };
}

// Public: no sign-in needed (the API returns 404 when the admin turned the page off).
export default async function StatusPage() {
  const t = await getTranslations('PublicStatus');
  const { branding } = await getPublicConfig();
  return <div className="min-h-dvh bg-background">
    <header className="border-b border-separator bg-surface/80 backdrop-blur">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <Brand branding={branding} href="/status"/>
        <div className="flex items-center gap-1"><AccessibilityButton/><LanguageMenu/><ThemeToggle/></div>
      </div>
    </header>
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <div><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('title')}</h1><p className="mt-1 text-sm text-muted">{t('intro', { name: branding.name })}</p></div>
      <StatusView/>
    </main>
  </div>;
}
