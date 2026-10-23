import { useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { getUser } from '../../../lib/session';
import Status from './status';
import RegistrationSetting from './registration-setting';

const modules = ['connections', 'pools', 'packages', 'customers', 'servers', 'audit'] as const;

export default async function AdminPage() {
  // The API enforces the role on every admin call; this only avoids rendering a useless page.
  if ((await getUser())?.role !== 'admin') {
    const t = await getTranslations('errors');
    return <article role="alert"><h1>403</h1><p>{t('FORBIDDEN')}</p></article>;
  }
  return <Admin/>;
}

function Admin() {
  const t = useTranslations('AdminPanel');
  return <><header><p className="eyebrow">{t('eyebrow')}</p><h1>{t('title')}</h1><p>{t('intro')}</p></header><Status/><RegistrationSetting/><section className="grid">{modules.map(m=><article key={m}><h2>{t(`modules.${m}`)}</h2><p className="muted">{t('planned')}</p><button disabled>{t('notImplemented')}</button></article>)}</section></>;
}
