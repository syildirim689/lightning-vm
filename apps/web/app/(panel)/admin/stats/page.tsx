import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Statistics from './stats';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Stats'))('title') };
}

export default function Page() {
  return <Statistics/>;
}
