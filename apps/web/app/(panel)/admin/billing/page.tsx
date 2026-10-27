import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import AdminBilling from './admin-billing';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('BillingAdmin'))('title') };
}

export default function Page() {
  return <Suspense><AdminBilling/></Suspense>;
}
