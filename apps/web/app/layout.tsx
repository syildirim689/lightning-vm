import './style.css';
import Link from 'next/link';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { setLocale } from '../i18n/actions';
import { locales } from '../i18n/config';
import pkg from '../package.json';

const languageNames = { tr: 'Türkçe', en: 'English' };

export async function generateMetadata() {
  const t = await getTranslations('Metadata');
  return { title: 'Lightning VM', description: t('description') };
}

export default async function Layout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations('Layout');
  return <html lang={locale}><body><aside><h2>ϟ Lightning VM</h2><small>{t('tagline')}</small><nav><Link href="/">{t('navUser')}</Link><Link href="/admin">{t('navAdmin')}</Link></nav>
    <form action={setLocale} className="lang" aria-label={t('language')}>{locales.map(l => <button key={l} name="locale" value={l} lang={l} aria-pressed={l === locale}>{languageNames[l]}</button>)}</form>
    <p className="muted">{t('build', { version: pkg.version })}</p></aside>
    <main><div className="notice">{t('notice')}</div><NextIntlClientProvider>{children}</NextIntlClientProvider></main></body></html>;
}
