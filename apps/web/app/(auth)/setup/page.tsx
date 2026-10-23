import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSetupStatus } from '../../../lib/session';
import CredentialsForm from '../credentials-form';

export default async function SetupPage() {
  if ((await getSetupStatus()).adminCreated) redirect('/login');
  const t = await getTranslations('Auth');
  return <article><h1>{t('setupTitle')}</h1><p>{t('setupIntro')}</p><pre><code>docker compose exec api node dist/cli.js bootstrap-token</code></pre><CredentialsForm mode="setup"/></article>;
}
