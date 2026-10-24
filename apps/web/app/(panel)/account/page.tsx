import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { SshKeys } from '../servers-ui';
import { Projects } from './account';
import Security from './security';

export default async function AccountPage() {
  const t = await getTranslations('Account');
  return <div className="flex flex-col gap-6">
    <PageHeader title={t('title')} description={t('intro')}/>
    <Security/>
    <SshKeys/>
    <Projects/>
  </div>;
}
