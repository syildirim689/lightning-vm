"use client";
// What a subscription is for, in the reader's language ("Server web-1", "Virtual data center Ankara"): the API
// stores the kind in one language (lib/billing.ts takes it apart).
import { useTranslations } from 'next-intl';
import { subscriptionName } from './billing';

export function useSubscriptionLabel() {
  const t = useTranslations('Billing');
  return (description: string) => { const { kind, name } = subscriptionName(description); return kind ? t(kind === 'server' ? 'subscriptionServer' : 'subscriptionVdc', { name }) : name; };
}
