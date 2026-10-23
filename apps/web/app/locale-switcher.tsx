import { getLocale, getTranslations } from 'next-intl/server';
import { setLocale } from '../i18n/actions';
import { locales } from '../i18n/config';

const languageNames = { tr: 'Türkçe', en: 'English' };

export default async function LocaleSwitcher() {
  const locale = await getLocale();
  const t = await getTranslations('Layout');
  return <form action={setLocale} className="lang" aria-label={t('language')}>{locales.map(l => <button key={l} name="locale" value={l} lang={l} aria-pressed={l === locale}>{languageNames[l]}</button>)}</form>;
}
