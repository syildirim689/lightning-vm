import NextLink from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSetupStatus } from '../../../lib/session';
import CredentialsForm from '../credentials-form';

export default async function LoginPage() {
  if (!(await getSetupStatus()).adminCreated) redirect('/setup');
  const t = await getTranslations('Auth');
  return <div className="w-full max-w-sm">
    <h1 className="text-2xl font-semibold tracking-tight">{t('loginTitle')}</h1>
    <p className="mb-6 mt-1 text-sm text-muted">{t('loginIntro')}</p>
    <CredentialsForm mode="login"/>
    <p className="mt-6 text-center text-sm text-muted"><NextLink className="font-medium text-accent hover:underline" href="/register">{t('toRegister')}</NextLink></p>
  </div>;
}
