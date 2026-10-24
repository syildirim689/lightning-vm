import { ServerDetail } from '../../servers-ui';

export default async function ServerPage({ params }: { params: Promise<{ id: string }> }) {
  return <ServerDetail id={(await params).id}/>;
}
