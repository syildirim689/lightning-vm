import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import Billing from './billing';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Billing'))('title') };
}

export default function Page() {
  return <Suspense><Billing/></Suspense>;
}
