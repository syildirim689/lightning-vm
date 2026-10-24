import ConnectionDetail from './detail';

export default async function ConnectionPage({ params }: { params: Promise<{ id: string }> }) {
  return <ConnectionDetail id={(await params).id}/>;
}
