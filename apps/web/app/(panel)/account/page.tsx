import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import AccountTabs from './tabs';

export default async function AccountPage() {
  const t = await getTranslations('Account');
  return <div className="flex flex-col gap-6">
    <PageHeader title={t('title')} description={t('intro')}/>
    <AccountTabs/>
  </div>;
}
