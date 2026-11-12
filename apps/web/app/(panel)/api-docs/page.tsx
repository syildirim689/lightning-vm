import { getTranslations } from 'next-intl/server';
import Reference from './reference';

export async function generateMetadata() { return { title: (await getTranslations('ApiDocs'))('title') }; }
export default function ApiDocsPage() { return <Reference/>; }
