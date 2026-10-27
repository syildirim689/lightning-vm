import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import InvoicePage from './invoice';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Billing'))('invoiceTitle') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <Suspense><InvoicePage id={(await params).id}/></Suspense>;
}
