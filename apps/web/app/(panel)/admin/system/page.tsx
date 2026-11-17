import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../../components/ui';
import HostSettings from '../host-settings';
import HostState from '../host-state';
import OsUpdates from '../os-updates';
import RestoreHold from '../restore-hold';
import Maintenance from '../maintenance';
import Status from '../status';
import Updates from '../updates';

export default async function SystemPage() {
  const t = await getTranslations('SystemPage');
  return <div className="flex flex-col gap-6">
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')}/>
    <RestoreHold/>
    <Status/>
    <HostState/>
    <HostSettings/>
    <OsUpdates/>
    <Updates/>
    <Maintenance/>
  </div>;
}
