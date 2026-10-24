import { redirect } from 'next/navigation';
import { getSetupStatus, getUser } from '../../lib/session';
import pkg from '../../package.json';
import Shell from './shell';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect((await getSetupStatus()).adminCreated ? '/login' : '/setup');
  return <Shell user={{ email: user.email, role: user.role }} version={pkg.version}>{children}</Shell>;
}
