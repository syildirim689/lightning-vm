import { TicketPage } from '../../../support/ui';
import { TicketDiagnostics } from './diagnostics';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Staff only: what was known about the ticket's server when it was opened. The customer's page never draws it.
  return <TicketPage id={id} staff before={<TicketDiagnostics id={id}/>}/>;
}
