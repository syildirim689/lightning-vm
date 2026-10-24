import { redirect } from 'next/navigation';
import { getPublicConfig, getSetupStatus, getUser } from '../../lib/session';
import pkg from '../../package.json';
import Shell from './shell';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect((await getSetupStatus()).adminCreated ? '/login' : '/setup');
  const { branding } = await getPublicConfig();
  return <Shell user={user} branding={branding} version={pkg.version}>{children}</Shell>;
}
