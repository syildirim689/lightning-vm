import { getTranslations } from 'next-intl/server';
import { I } from '../../components/icon';
import { ButtonLink, PageHeader } from '../../components/ui';
import Insights from '../../components/insights';
import { ServerList } from './servers-ui';

export default async function Page() {
  const t = await getTranslations('UserPanel');
  const tn = await getTranslations('Nav');
  return <>
    <PageHeader title={t('title')} description={t('intro')} actions={<ButtonLink href="/order"><I name="plus" size={16}/>{tn('newServer')}</ButtonLink>}/>
    <div className="flex flex-col gap-6"><Insights scope="mine"/><ServerList/></div>
  </>;
}
