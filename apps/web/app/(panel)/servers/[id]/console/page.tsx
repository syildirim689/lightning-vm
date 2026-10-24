import ConsoleView from '../../../admin/vmware/console/console-view';

// Customer console: the API checks that the server belongs to the caller before issuing a session.
export default async function ServerConsolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ConsoleView sessionPath={`/servers/${id}/console`} title=""/>;
}
