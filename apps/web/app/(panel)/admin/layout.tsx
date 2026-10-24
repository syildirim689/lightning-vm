import { getTranslations } from 'next-intl/server';
import { getUser } from '../../../lib/session';

// The API enforces the role on every admin call; this only avoids rendering useless admin pages.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if ((await getUser())?.role === 'admin') return children;
  const t = await getTranslations('errors');
  return <div role="alert" className="mx-auto mt-16 max-w-md text-center"><p className="text-5xl font-semibold text-muted">403</p><p className="mt-2">{t('FORBIDDEN')}</p></div>;
}
