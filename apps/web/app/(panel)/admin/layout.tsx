import { getTranslations } from 'next-intl/server';
import { isStaff } from '../../../lib/permissions';
import { getUser } from '../../../lib/session';

// The API enforces each permission on every call; this only avoids rendering staff pages to customers.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (isStaff((await getUser())?.permissions)) return children;
  const t = await getTranslations('errors');
  return <div role="alert" className="mx-auto mt-16 max-w-md text-center"><p className="text-5xl font-semibold text-muted">403</p><p className="mt-2">{t('FORBIDDEN')}</p></div>;
}
