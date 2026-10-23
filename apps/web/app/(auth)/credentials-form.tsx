"use client";
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { apiFetch, useErrorText, type ApiError } from '../../lib/api';

type Mode = 'login' | 'register' | 'setup';
const endpoints: Record<Mode, string> = { login: '/auth/login', register: '/auth/register', setup: '/setup/admin' };

export default function CredentialsForm({ mode }: { mode: Mode }) {
  const t = useTranslations('Auth');
  const { error, field } = useErrorText();
  const locale = useLocale();
  const router = useRouter();
  const [failure, setFailure] = useState<ApiError & { text: string }>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setFailure(undefined);
    const form = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const user = await apiFetch<{ role: string }>(endpoints[mode], { method: 'POST', body: { ...form, locale } });
      router.replace(user.role === 'admin' ? '/admin' : '/');
      router.refresh();
    } catch (err) { setFailure({ ...(err as ApiError), text: error(err) }); setBusy(false); }
  }

  const fieldError = (name: string) => field(failure?.fields?.[name]);
  const input = (name: string, type: string, autoComplete: string, extra: object = {}) => <>
    <label htmlFor={name}>{t(name as 'email')}<span className="muted"> · {t('required')}</span></label>
    <input id={name} name={name} type={type} autoComplete={autoComplete} required aria-invalid={!!fieldError(name)} aria-describedby={`${name}-help`} {...extra}/>
    <small id={`${name}-help`} className={fieldError(name) ? 'error' : 'muted'}>{fieldError(name) ?? t(`${name}Help` as 'emailHelp')}</small>
  </>;

  return <form onSubmit={submit} noValidate>
    {mode === 'setup' && input('token', 'password', 'one-time-code', { spellCheck: false })}
    {input('email', 'email', 'username', { maxLength: 254 })}
    {input('password', 'password', mode === 'login' ? 'current-password' : 'new-password', { minLength: mode === 'login' ? undefined : 12, maxLength: 256 })}
    {failure && <p role="alert" className="error">{failure.text}</p>}
    <button type="submit" className="primary" disabled={busy}>{busy ? t('working') : t(`${mode}Submit`)}</button>
  </form>;
}
