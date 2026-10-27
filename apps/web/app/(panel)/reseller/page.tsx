import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import Reseller from './reseller';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Reseller'))('title') };
}

export default function Page() {
  return <Suspense><Reseller/></Suspense>;
}
