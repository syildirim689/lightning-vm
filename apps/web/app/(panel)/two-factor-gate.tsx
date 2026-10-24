"use client";
// The admin requires two-factor for this account and it is not set up yet: the panel stays closed (the API
// refuses everything else too) until it is. Backup codes are shown before the panel opens.
import { Button } from '@heroui/react';
import { motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { I } from '../../components/icon';
import { signOut } from '../../lib/auth-client';
import { useMe } from '../../lib/me';
import { PhoneNumber, TwoFactor } from './account/two-factor';

export default function TwoFactorGate() {
  const t = useTranslations('Auth.gate');
  const router = useRouter();
  const me = useMe();
  return <main className="grid min-h-dvh place-items-center px-4 py-10">
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex w-full max-w-xl flex-col gap-6 rounded-3xl border border-border bg-surface p-6 sm:p-8">
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-2xl bg-warning-soft text-warning"><I name="shield-alert" size={22}/></span>
        <div><h1 className="text-xl font-semibold">{t('title')}</h1><p className="mt-1 text-sm text-muted">{t('intro')}</p></div>
      </div>
      <TwoFactor/>
      <PhoneNumber/>
      <div className="flex flex-wrap justify-between gap-2 border-t border-separator pt-4">
        <Button variant="ghost" onPress={async () => { await signOut(); router.replace('/login'); }}><I name="log-out" size={16}/>{t('signOut')}</Button>
        <Button isDisabled={!me?.twoFactorEnabled} onPress={() => router.refresh()}><I name="arrow-right" size={16}/>{t('continue')}</Button>
      </div>
    </motion.div>
  </main>;
}
