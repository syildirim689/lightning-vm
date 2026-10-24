import './style.css';
import { Fira_Code, Fira_Sans } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { accentCss } from '../components/brand';
import { getPublicConfig } from '../lib/session';
import Providers from './providers';

const sans = Fira_Sans({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600', '700'], variable: '--font-fira-sans', display: 'swap' });
const mono = Fira_Code({ subsets: ['latin', 'latin-ext'], weight: ['400', '500'], variable: '--font-fira-code', display: 'swap' });

export async function generateMetadata() {
  const t = await getTranslations('Metadata');
  const { branding } = await getPublicConfig();
  return { title: { default: branding.name, template: `%s · ${branding.name}` }, description: t('description'),
    icons: branding.favicon ? { icon: `/api/public/branding/favicon?v=${branding.version}` } : undefined, manifest: undefined };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const { branding } = await getPublicConfig();
  const css = accentCss(branding.accent);
  return <html lang={locale} className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
    {/* The accent is validated as #rrggbb by the API before it is stored. */}
    {css && <head><style dangerouslySetInnerHTML={{ __html: css }}/></head>}
    <body className="bg-background text-foreground font-sans antialiased">
      <NextIntlClientProvider><Providers locale={locale}>{children}</Providers></NextIntlClientProvider>
    </body>
  </html>;
}
