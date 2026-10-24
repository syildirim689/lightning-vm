import { getTranslations } from 'next-intl/server';
import Roles from './roles';

export async function generateMetadata() { return { title: (await getTranslations('Roles'))('title') }; }
export default function RolesPage() { return <Roles/>; }
