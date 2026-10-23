import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSetupStatus } from '../../../lib/session';
import CredentialsForm from '../credentials-form';

export default async function LoginPage() {
  if (!(await getSetupStatus()).adminCreated) redirect('/setup');
  const t = await getTranslations('Auth');
  return <article><h1>{t('loginTitle')}</h1><CredentialsForm mode="login"/><p className="muted"><Link href="/register">{t('toRegister')}</Link></p></article>;
}
