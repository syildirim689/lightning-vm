import { getTranslations } from 'next-intl/server';
import { getUser } from '../../../../lib/session';
import Catalog from './catalog';

export default async function CatalogPage() {
  if ((await getUser())?.role !== 'admin') {
    const t = await getTranslations('errors');
    return <article role="alert"><h1>403</h1><p>{t('FORBIDDEN')}</p></article>;
  }
  const t = await getTranslations('Catalog');
  return <><header><p className="eyebrow">{t('eyebrow')}</p><h1>{t('title')}</h1><p>{t('intro')}</p></header><Catalog/></>;
}
