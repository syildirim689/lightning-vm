import { redirect } from 'next/navigation';
import { getSetupStatus } from '../../../lib/session';
import Wizard from './wizard';

export default async function SetupPage() {
  // Reopening a completed wizard needs `node dist/cli.js recover-setup` on the server.
  if ((await getSetupStatus()).completed) redirect('/login');
  return <Wizard/>;
}
