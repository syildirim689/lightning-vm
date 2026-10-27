import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import AdminInvoice from './admin-invoice';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Billing'))('invoiceTitle') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <AdminInvoice id={(await params).id}/>;
}
