import { getTranslations } from 'next-intl/server';
import { getUser } from '../../../../../lib/session';
import ConsoleView from './console-view';

export default async function ConsolePage({ searchParams }: { searchParams: Promise<{ c?: string; vm?: string }> }) {
  if ((await getUser())?.role !== 'admin') {
    const t = await getTranslations('errors');
    return <article role="alert"><h1>403</h1><p>{t('FORBIDDEN')}</p></article>;
  }
  // Only identifiers travel in the URL; the console session is issued by POST and kept in a cookie.
  const { c, vm } = await searchParams;
  if (!c || !vm) {
    const t = await getTranslations('errors');
    return <article role="alert"><p>{t('NOT_FOUND')}</p></article>;
  }
  return <ConsoleView connection={c} vm={vm}/>;
}
