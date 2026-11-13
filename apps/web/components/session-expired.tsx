"use client";
// The session ran out while something was typed and not saved: instead of sending the person to the sign-in page
// (and losing it), say so and let them sign in again in another tab. This page notices when the session is back,
// says they can save now and reconnects live updates. Signing out stays one press away.
import { toast } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { ConfirmDialog } from './ui';

export default function SessionExpired() {
  const t = useTranslations('SessionExpired');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('lvm:expired', show);
    return () => window.removeEventListener('lvm:expired', show);
  }, []);
  // While it is open (or closed with the session still gone), check every few seconds whether they are back.
  const [waiting, setWaiting] = useState(false);
  useEffect(() => { if (open) setWaiting(true); }, [open]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      apiFetch('/auth/me').then(() => {
        setWaiting(false); setOpen(false);
        toast.success(t('back'));
        window.dispatchEvent(new Event('lvm:session-back'));
      }, () => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [waiting, t]);
  return <ConfirmDialog isOpen={open} onClose={() => setOpen(false)} status="warning" title={t('title')}
    body={<div className="flex flex-col gap-2"><p>{t('body')}</p>
      <p><button type="button" className="font-medium text-danger hover:underline" onClick={() => window.location.replace('/login?reason=expired')}>{t('leave')}</button></p></div>}
    confirmLabel={t('signIn')} cancelLabel={t('stay')}
    onConfirm={() => { window.open('/login?reason=expired', '_blank', 'noopener'); }}/>;
}
