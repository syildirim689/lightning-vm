import { getTranslations } from 'next-intl/server';
import { getUser } from '../../../../lib/session';
import Connections from './connections';

export default async function VmwarePage() {
  if ((await getUser())?.role !== 'admin') {
    const t = await getTranslations('errors');
    return <article role="alert"><h1>403</h1><p>{t('FORBIDDEN')}</p></article>;
  }
  const t = await getTranslations('Vmware');
  return <><header><p className="eyebrow">{t('eyebrow')}</p><h1>{t('title')}</h1><p>{t('intro')}</p></header><Connections/></>;
}
