import { redirect } from 'next/navigation';
import { getPublicConfig, getSetupStatus, getUser } from '../../lib/session';
import pkg from '../../package.json';
import Shell from './shell';
import TwoFactorGate from './two-factor-gate';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect((await getSetupStatus()).adminCreated ? '/login' : '/setup');
  if (user.twoFactorRequired) return <TwoFactorGate/>;
  const { branding } = await getPublicConfig();
  // The installed release (vX.Y.Z or a commit); package.json's version when run outside Compose.
  const installed = process.env.APP_VERSION && process.env.APP_VERSION !== 'dev' ? process.env.APP_VERSION.replace(/^v/, '') : pkg.version;
  return <Shell user={user} branding={branding} version={installed}>{children}</Shell>;
}
