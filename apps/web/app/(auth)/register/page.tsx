import NextLink from 'next/link';
import { getTranslations } from 'next-intl/server';
import CredentialsForm from '../credentials-form';

export default async function RegisterPage() {
  const t = await getTranslations('Auth');
  return <div className="w-full max-w-sm">
    <h1 className="text-2xl font-semibold tracking-tight">{t('registerTitle')}</h1>
    <p className="mb-6 mt-1 text-sm text-muted">{t('registerIntro')}</p>
    <CredentialsForm mode="register"/>
    <p className="mt-6 text-center text-sm text-muted"><NextLink className="font-medium text-accent hover:underline" href="/login">{t('toLogin')}</NextLink></p>
  </div>;
}
