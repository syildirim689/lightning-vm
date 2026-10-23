"use client";
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { apiFetch, useErrorText } from '../../lib/api';

export default function LogoutButton() {
  const t = useTranslations('Layout');
  const { error } = useErrorText();
  const router = useRouter();
  const [failure, setFailure] = useState<string>();
  async function logout() {
    try { await apiFetch('/auth/logout', { method: 'POST' }); router.replace('/login'); router.refresh(); }
    catch (e) { setFailure(error(e)); }
  }
  return <><button type="button" className="secondary" onClick={logout}>{t('logout')}</button>{failure && <p role="alert" className="error">{failure}</p>}</>;
}
