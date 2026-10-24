import { getTranslations } from 'next-intl/server';
import Settings from './settings';

export async function generateMetadata() { return { title: (await getTranslations('Settings'))('title') }; }
export default function SettingsPage() { return <Settings/>; }
