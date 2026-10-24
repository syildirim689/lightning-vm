import './style.css';
import { Fira_Code, Fira_Sans } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import Providers from './providers';

const sans = Fira_Sans({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600', '700'], variable: '--font-fira-sans', display: 'swap' });
const mono = Fira_Code({ subsets: ['latin', 'latin-ext'], weight: ['400', '500'], variable: '--font-fira-code', display: 'swap' });

export async function generateMetadata() {
  const t = await getTranslations('Metadata');
  return { title: { default: 'Lightning VM', template: '%s · Lightning VM' }, description: t('description') };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return <html lang={locale} className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
    <body className="bg-background text-foreground font-sans antialiased">
      <NextIntlClientProvider><Providers locale={locale}>{children}</Providers></NextIntlClientProvider>
    </body>
  </html>;
}
