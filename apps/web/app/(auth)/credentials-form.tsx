"use client";
import { Button, Separator } from '@heroui/react';
import { Turnstile } from '@marsidev/react-turnstile';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { I } from '../../components/icon';
import { Notice, TextInput } from '../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../lib/api';
import { authClient } from '../../lib/auth-client';
import { useApiQuery } from '../../lib/query';

type Mode = 'login' | 'register' | 'setup';
export type PublicConfig = { passwordReset: boolean; turnstileSiteKey: string | null };

// Same limits as the API; the server stays the authority, this only answers early and in the user's language.
const schema = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(256) });
const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1) });

// better-auth's client returns { error: { code, status } }; a 429 carries no code.
const asApiError = (e: { code?: string; status?: number } | null | undefined): ApiError => ({ code: e?.code ?? (e?.status === 429 ? 'RATE_LIMITED' : 'UNKNOWN') });

// In the setup wizard the token already sits in an HttpOnly cookie (noToken) and the wizard moves on (onDone).
export default function CredentialsForm({ mode, noToken, onDone }: { mode: Mode; noToken?: boolean; onDone?: () => void }) {
  const t = useTranslations('Auth');
  const { error, field } = useErrorText();
  const locale = useLocale();
  const router = useRouter();
  const cfg = useApiQuery<PublicConfig>(['public-config'], '/public/config').data;
  const [values, setValues] = useState({ token: '', email: '', password: '' });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState<'password' | 'passkey'>();
  const [captcha, setCaptcha] = useState<string>();
  const set = (k: keyof typeof values) => (v: string) => { setValues((x) => ({ ...x, [k]: v })); setFields((f) => ({ ...f, [k]: '' })); };
  const needsCaptcha = mode !== 'setup' && !!cfg?.turnstileSiteKey;

  async function landed() {
    const me = await apiFetch<{ role: string }>('/auth/me');
    router.replace(me.role === 'admin' ? '/admin' : '/');
    router.refresh();
  }

  // Passkeys offered by the browser's autofill on the e-mail field (conditional mediation), where supported.
  useEffect(() => {
    if (mode !== 'login' || typeof window === 'undefined' || !window.PublicKeyCredential?.isConditionalMediationAvailable) return;
    let active = true;
    window.PublicKeyCredential.isConditionalMediationAvailable().then((ok) => {
      if (ok && active) void authClient.signIn.passkey({ autoFill: true }).then(({ error: e }) => { if (!e && active) void landed(); });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFailure(undefined);
    const parsed = (mode === 'login' ? loginSchema : schema).safeParse(values);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const k = String(issue.path[0]);
        next[k] = k === 'email' ? 'INVALID_EMAIL' : issue.code === 'too_big' ? 'PASSWORD_TOO_LONG' : mode === 'login' ? 'REQUIRED' : 'PASSWORD_TOO_SHORT';
      }
      setFields(next); return;
    }
    if (needsCaptcha && !captcha) { setFailure(t('captchaRequired')); return; }
    setBusy('password');
    const fetchOptions = captcha ? { headers: { 'x-captcha-response': captcha } } : undefined;
    try {
      if (mode === 'setup') {
        await apiFetch('/setup/admin', { method: 'POST', body: { ...(noToken ? {} : { token: values.token }), email: values.email, password: values.password, locale } });
        onDone?.(); return;
      }
      const { error: err } = mode === 'login'
        ? await authClient.signIn.email({ email: values.email, password: values.password, fetchOptions })
        : await authClient.signUp.email({ email: values.email, password: values.password, name: '', locale, fetchOptions } as Parameters<typeof authClient.signUp.email>[0]);
      if (err) { setFailure(error(asApiError(err))); return; }
      await landed();
    } catch (err) {
      const apiErr = err as ApiError;
      setFields(apiErr.fields ?? {}); setFailure(error(apiErr));
    } finally { setBusy(undefined); }
  }

  async function passkey() {
    setFailure(undefined); setBusy('passkey');
    const { error: err } = await authClient.signIn.passkey();
    setBusy(undefined);
    if (err) { if (asApiError(err).code !== 'AUTH_CANCELLED') setFailure(error(asApiError(err))); return; }
    await landed();
  }

  return <form onSubmit={submit} noValidate className="flex flex-col gap-4">
    {mode === 'setup' && !noToken && <TextInput label={t('token')} type="password" value={values.token} onChange={set('token')} autoComplete="one-time-code" spellCheck={false} help={t('tokenHelp')} isRequired/>}
    <TextInput label={t('email')} type="email" value={values.email} onChange={set('email')} autoComplete={mode === 'login' ? 'username webauthn' : 'username'} maxLength={254}
      error={field(fields.email)} help={t('emailHelp')} isRequired/>
    <TextInput label={t('password')} type="password" value={values.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password webauthn' : 'new-password'} maxLength={256}
      error={field(fields.password)} help={mode === 'login' ? undefined : t('passwordHelp')} isRequired/>
    {mode === 'login' && cfg?.passwordReset && <NextLink href="/forgot-password" className="-mt-2 self-end text-sm text-accent hover:underline">{t('forgot')}</NextLink>}
    {needsCaptcha && <Turnstile siteKey={cfg!.turnstileSiteKey!} onSuccess={setCaptcha} onExpire={() => setCaptcha(undefined)} options={{ language: locale, theme: 'auto', size: 'flexible' }}/>}
    {failure && <div role="alert"><Notice tone="danger">{failure}</Notice></div>}
    <Button type="submit" size="lg" fullWidth isPending={busy === 'password'} isDisabled={!!busy}>{busy === 'password' ? t('working') : t(`${mode}Submit`)}</Button>
    {mode === 'login' && <>
      <div className="flex items-center gap-3 text-xs text-muted"><Separator className="flex-1"/>{t('or')}<Separator className="flex-1"/></div>
      <Button variant="secondary" size="lg" fullWidth isPending={busy === 'passkey'} isDisabled={!!busy} onPress={passkey}><I name="fingerprint" size={18}/>{t('passkeySignIn')}</Button>
    </>}
  </form>;
}
