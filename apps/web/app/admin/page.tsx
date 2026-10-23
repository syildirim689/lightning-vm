import { useTranslations } from 'next-intl';
import Status from './status';

const modules = ['connections', 'pools', 'packages', 'customers', 'servers', 'audit'] as const;

export default function Admin() {
  const t = useTranslations('AdminPanel');
  return <><header><p className="eyebrow">{t('eyebrow')}</p><h1>{t('title')}</h1><p>{t('intro')}</p></header><Status/><section className="grid">{modules.map(m=><article key={m}><h2>{t(`modules.${m}`)}</h2><p className="muted">{t('planned')}</p><button disabled>{t('notImplemented')}</button></article>)}</section></>;
}
