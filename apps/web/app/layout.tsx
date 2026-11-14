import './style.css';
import { Atkinson_Hyperlegible, Fira_Code, Fira_Sans } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { accentCss } from '../components/brand';
import { a11yBootScript } from '../lib/a11y-prefs';
import { getPublicConfig } from '../lib/session';
import { pick, publicScope } from '../lib/message-scope';
import Providers from './providers';
import { LoaderLayer } from '../components/page-loader';

const sans = Fira_Sans({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600', '700'], variable: '--font-fira-sans', display: 'swap' });
// Offered in the accessibility settings (high legibility for low vision and dyslexia).
const legible = Atkinson_Hyperlegible({ subsets: ['latin', 'latin-ext'], weight: ['400', '700'], variable: '--font-legible', display: 'swap' });
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
  const t = await getTranslations('Layout');
  return <html lang={locale} className={`${sans.variable} ${mono.variable} ${legible.variable}`} suppressHydrationWarning>
    {/* The accent is validated as #rrggbb by the API before it is stored. */}
    <head>
      {/* Saved accessibility preferences, applied before the first paint. */}
      <script dangerouslySetInnerHTML={{ __html: a11yBootScript }}/>
      {css && <style dangerouslySetInnerHTML={{ __html: css }}/>}
    </head>
    <body className="bg-background text-foreground font-sans antialiased">
      {/* First paint: the loading layer, faded out by PageLoader once the page is interactive. */}
      <LoaderLayer id="boot-loader" label={t('loading')}/>
      {/* Only the public pages' translations here; the panel and the setup wizard add their own (lib/message-scope). */}
      <NextIntlClientProvider messages={pick(await getMessages(), publicScope)}><Providers locale={locale} loadingLabel={t('loading')}>{children}</Providers></NextIntlClientProvider>
    </body>
  </html>;
}
