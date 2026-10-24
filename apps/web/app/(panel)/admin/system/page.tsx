import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../../components/ui';
import Maintenance from '../maintenance';
import RegistrationSetting from '../registration-setting';
import Status from '../status';

export default async function SystemPage() {
  const t = await getTranslations('SystemPage');
  return <div className="flex flex-col gap-6">
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')}/>
    <div className="grid gap-6 lg:grid-cols-2"><Status/><RegistrationSetting/></div>
    <Maintenance/>
  </div>;
}
