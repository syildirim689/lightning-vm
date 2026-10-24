import { getTranslations } from 'next-intl/server';
import FirewallDetail from './detail';

export async function generateMetadata() { return { title: (await getTranslations('Firewalls'))('title') }; }
export default async function FirewallPage({ params }: { params: Promise<{ id: string }> }) {
  return <FirewallDetail id={(await params).id}/>;
}
