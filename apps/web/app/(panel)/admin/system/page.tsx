import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../../components/ui';
import Maintenance from '../maintenance';
import Status from '../status';

export default async function SystemPage() {
  const t = await getTranslations('SystemPage');
  return <div className="flex flex-col gap-6">
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')}/>
    <Status/>
    <Maintenance/>
  </div>;
}
