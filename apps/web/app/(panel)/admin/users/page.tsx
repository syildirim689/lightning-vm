import { getTranslations } from 'next-intl/server';
import Users from './users';

export async function generateMetadata() { return { title: (await getTranslations('Users'))('title') }; }
export default function UsersPage() { return <Users/>; }
