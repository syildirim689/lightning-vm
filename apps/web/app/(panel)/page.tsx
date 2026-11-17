import { getTranslations } from 'next-intl/server';
import { I } from '../../components/icon';
import { ButtonLink, PageHeader } from '../../components/ui';
import Insights from '../../components/insights';
import { CostForecast } from '../../components/smart';
import FirstSteps from '../../components/first-steps';
import Welcome from '../../components/welcome';
import UpcomingCharges from '../../components/upcoming-charges';
import { ServerList } from './servers-ui';

export default async function Page() {
  const t = await getTranslations('UserPanel');
  const tn = await getTranslations('Nav');
  return <>
    <PageHeader title={t('title')} description={t('intro')} actions={<ButtonLink href="/order"><I name="plus" size={16}/>{tn('newServer')}</ButtonLink>}/>
    <div className="flex flex-col gap-6">
      <Welcome/>
      <UpcomingCharges/>
      <FirstSteps/>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"><Insights scope="mine"/><CostForecast/></div>
      <ServerList/>
    </div>
  </>;
}
