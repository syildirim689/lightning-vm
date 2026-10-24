import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSetupStatus } from '../../../lib/session';
import { AuthCard } from '../auth-card';
import CredentialsForm from '../credentials-form';

export default async function LoginPage() {
  if (!(await getSetupStatus()).adminCreated) redirect('/setup');
  const t = await getTranslations('Auth');
  return <AuthCard title={t('loginTitle')} intro={t('loginIntro')}><CredentialsForm mode="login"/></AuthCard>;
}
