import { useTranslations } from 'next-intl';

export default function Page() {
  const t = useTranslations('UserPanel');
  return <><header><p className="eyebrow">{t('eyebrow')}</p><h1>{t('title')}</h1><p>{t('intro')}</p></header><section className="grid"><article><h2>{t('packageTitle')}</h2><p>{t('packageText')}</p><button disabled>{t('comingSoon')}</button></article><article><h2>{t('customTitle')}</h2><p>{t('customText')}</p><button disabled>{t('comingSoon')}</button></article></section><article><h2>{t('serversTitle')}</h2><p className="muted">{t('serversEmpty')}</p></article><article><h2>{t('consoleTitle')}</h2><p>{t('consoleText')}</p></article></>;
}
