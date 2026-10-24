import { useTranslations } from 'next-intl';
import UserPanel from './user-panel';

export default function Page() {
  const t = useTranslations('UserPanel');
  return <><header><p className="eyebrow">{t('eyebrow')}</p><h1>{t('title')}</h1><p>{t('intro')}</p></header><UserPanel/></>;
}
