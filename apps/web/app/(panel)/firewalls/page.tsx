import { getTranslations } from 'next-intl/server';
import Firewalls from './firewalls';

export async function generateMetadata() { return { title: (await getTranslations('Firewalls'))('title') }; }
export default function FirewallsPage() { return <Firewalls/>; }
