import './style.css';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';

export async function generateMetadata() {
  const t = await getTranslations('Metadata');
  return { title: 'Lightning VM', description: t('description') };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang={await getLocale()}><body><NextIntlClientProvider>{children}</NextIntlClientProvider></body></html>;
}
