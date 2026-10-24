import { getTranslations } from 'next-intl/server';
import Connections from './connections';
import ActiveConsoles from './active-consoles';

export default async function VmwarePage() {
  const t = await getTranslations('Vmware');
  return <div className="flex flex-col gap-6"><Connections eyebrow={t('eyebrow')} title={t('title')} intro={t('intro')}/><ActiveConsoles/></div>;
}
