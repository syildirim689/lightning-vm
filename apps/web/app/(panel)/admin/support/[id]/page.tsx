import { TicketPage } from '../../../support/ui';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <TicketPage id={(await params).id} staff/>;
}
