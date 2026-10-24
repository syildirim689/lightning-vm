import { getTranslations } from 'next-intl/server';
import { AuthCard } from '../auth-card';
import CredentialsForm from '../credentials-form';

export default async function RegisterPage() {
  const t = await getTranslations('Auth');
  return <AuthCard title={t('registerTitle')} intro={t('registerIntro')}><CredentialsForm mode="register"/></AuthCard>;
}
