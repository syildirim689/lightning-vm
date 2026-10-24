import { getTranslations } from 'next-intl/server';
import { getUser } from '../../../../lib/session';
import AdminServers from './admin-servers';

export default async function AdminServersPage() {
  if ((await getUser())?.role !== 'admin') {
    const t = await getTranslations('errors');
    return <article role="alert"><h1>403</h1><p>{t('FORBIDDEN')}</p></article>;
  }
  const t = await getTranslations('Servers');
  return <><header><p className="eyebrow">{t('admin.eyebrow')}</p><h1>{t('admin.title')}</h1><p>{t('admin.intro')}</p></header><AdminServers/></>;
}
