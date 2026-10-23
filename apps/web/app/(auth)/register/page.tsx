import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import CredentialsForm from '../credentials-form';

export default async function RegisterPage() {
  const t = await getTranslations('Auth');
  return <article><h1>{t('registerTitle')}</h1><p className="muted">{t('registerIntro')}</p><CredentialsForm mode="register"/><p className="muted"><Link href="/login">{t('toLogin')}</Link></p></article>;
}
