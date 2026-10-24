import { getTranslations } from 'next-intl/server';
import ConsoleView from './console-view';

export default async function ConsolePage({ searchParams }: { searchParams: Promise<{ c?: string; vm?: string }> }) {
  // Only identifiers travel in the URL; the console session is issued by POST and kept in a cookie.
  const { c, vm } = await searchParams;
  if (!c || !vm) {
    const t = await getTranslations('errors');
    return <p role="alert">{t('NOT_FOUND')}</p>;
  }
  return <ConsoleView sessionPath={`/admin/vmware/connections/${c}/vms/${encodeURIComponent(vm)}/console`} title={vm}/>;
}
