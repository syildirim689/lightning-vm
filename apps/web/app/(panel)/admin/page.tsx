import { getSetupStatus } from '../../../lib/session';
import Dashboard from './dashboard';

export default async function AdminPage() {
  return <Dashboard setupOpen={!(await getSetupStatus()).completed}/>;
}
