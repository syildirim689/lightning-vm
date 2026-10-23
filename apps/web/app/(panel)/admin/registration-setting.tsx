"use client";
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiFetch, useErrorText } from '../../../lib/api';

export default function RegistrationSetting() {
  const t = useTranslations('AdminPanel');
  const { error } = useErrorText();
  const [open, setOpen] = useState<boolean>();
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    apiFetch<{ registrationOpen: boolean }>('/admin/settings').then((s) => setOpen(s.registrationOpen), (e) => setMessage(error(e)));
  }, []); // load once; error() only formats text
  async function change(value: boolean) {
    setMessage(undefined);
    try { setOpen((await apiFetch<{ registrationOpen: boolean }>('/admin/settings', { method: 'PUT', body: { registrationOpen: value } })).registrationOpen); setMessage(t('saved')); }
    catch (e) { setMessage(error(e)); }
  }
  return <article><h2>{t('registrationTitle')}</h2><p className="muted">{t('registrationHelp')}</p>
    <label className="check"><input type="checkbox" checked={open ?? false} disabled={open === undefined} onChange={(e) => change(e.target.checked)}/>{t('registrationOpen')}</label>
    {message && <p aria-live="polite">{message}</p>}</article>;
}
