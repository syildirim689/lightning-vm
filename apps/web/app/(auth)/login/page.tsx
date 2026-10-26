import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSetupStatus } from '../../../lib/session';
import { AuthCard } from '../auth-card';
import CredentialsForm from '../credentials-form';
import { Notice } from '../../../components/ui';

const reasons = ['banned', 'password', 'revoked', 'removed', 'expired'] as const;

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const asked = (await searchParams).reason;
  const reason = reasons.find((r) => r === asked);
  if (!(await getSetupStatus()).adminCreated) redirect('/setup');
  const t = await getTranslations('Auth');
  return <AuthCard title={t('loginTitle')} intro={t('loginIntro')}>
    {reason && <div role="alert" className="mb-4"><Notice tone={reason === 'banned' || reason === 'removed' ? 'danger' : 'warning'} title={t(`signedOut.${reason}.title`)}>{t(`signedOut.${reason}.body`)}</Notice></div>}
    <CredentialsForm mode="login"/>
  </AuthCard>;
}
