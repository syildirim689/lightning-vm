import { TicketPage } from '../ui';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <TicketPage id={(await params).id} staff={false}/>;
}
