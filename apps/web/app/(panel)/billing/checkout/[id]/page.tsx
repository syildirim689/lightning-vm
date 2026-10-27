import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Checkout from './checkout';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Billing.checkout'))('title') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <Checkout id={(await params).id}/>;
}
