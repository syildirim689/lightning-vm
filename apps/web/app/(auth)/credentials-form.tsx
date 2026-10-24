"use client";
import { Button, Chip, InputOTP, Separator, Tabs } from '@heroui/react';
import { AnimatePresence, motion } from 'motion/react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useCaptcha } from '../../components/captcha';
import { I } from '../../components/icon';
import { CheckboxInput, Notice, TextInput } from '../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../lib/api';
import { authClient } from '../../lib/auth-client';
import { can } from '../../lib/permissions';
import { useApiQuery } from '../../lib/query';
import type { PublicConfig, User } from '../../lib/session';

type Mode = 'login' | 'register' | 'setup';
export type { PublicConfig };

// Same limits as the API; the server stays the authority, this only answers early and in the user's language.
const schema = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(256) });
const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1) });

// better-auth's client returns { error: { code, status } }; a 429 carries no code.
export const asApiError = (e: { code?: string; status?: number } | null | undefined): ApiError => ({ code: e?.code ?? (e?.status === 429 ? 'RATE_LIMITED' : 'UNKNOWN') });

export async function landed(router: ReturnType<typeof useRouter>) {
  const me = await apiFetch<User>('/auth/me');
  router.replace(can(me.permissions, 'dashboard.view') ? '/admin' : '/');
  router.refresh();
}

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
  const [secondStep, setSecondStep] = useState(false);
  const [lastMethod, setLastMethod] = useState<string | null>(null);
  const set = (k: keyof typeof values) => (v: string) => { setValues((x) => ({ ...x, [k]: v })); setFields((f) => ({ ...f, [k]: '' })); };
  const form = mode === 'login' ? 'signIn' : 'signUp';
  const captcha = useCaptcha(mode !== 'setup' && cfg?.captcha?.use[form] ? cfg.captcha : null, mode === 'login' ? 'login' : 'signup');

  useEffect(() => { if (mode === 'login') setLastMethod(authClient.getLastUsedLoginMethod?.() ?? null); }, [mode]);

  // Passkeys offered by the browser's autofill on the e-mail field (conditional mediation), where supported.
  useEffect(() => {
    if (mode !== 'login' || typeof window === 'undefined' || !window.PublicKeyCredential?.isConditionalMediationAvailable) return;
    let active = true;
    window.PublicKeyCredential.isConditionalMediationAvailable().then((ok) => {
      if (ok && active) void authClient.signIn.passkey({ autoFill: true }).then(({ error: e }) => { if (!e && active) void landed(router); });
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
    setBusy('password');
    try {
      const token = captcha.active ? await captcha.getToken() : undefined;
      if (captcha.active && !token) { setFailure(t('captchaRequired')); return; }
      const fetchOptions = token ? { headers: { 'x-captcha-response': token } } : undefined;
      if (mode === 'setup') {
        await apiFetch('/setup/admin', { method: 'POST', body: { ...(noToken ? {} : { token: values.token }), email: values.email, password: values.password, locale } });
        onDone?.(); return;
      }
      const res = mode === 'login'
        ? await authClient.signIn.email({ email: values.email, password: values.password, fetchOptions })
        : await authClient.signUp.email({ email: values.email, password: values.password, name: '', locale, fetchOptions } as Parameters<typeof authClient.signUp.email>[0]);
      if (res.error) { setFailure(error(asApiError(res.error))); captcha.reset(); return; }
      if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) { setSecondStep(true); return; }
      await landed(router);
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
    await landed(router);
  }

  if (secondStep) return <SecondFactor onBack={() => setSecondStep(false)}/>;
  const lastBadge = <Chip size="sm" variant="soft" color="accent">{t('lastUsed')}</Chip>;
  return <form onSubmit={submit} noValidate className="flex flex-col gap-4">
    {mode === 'setup' && !noToken && <TextInput label={t('token')} type="password" value={values.token} onChange={set('token')} autoComplete="one-time-code" spellCheck={false} help={t('tokenHelp')} isRequired/>}
    <TextInput label={t('email')} type="email" value={values.email} onChange={set('email')} autoComplete={mode === 'login' ? 'username webauthn' : 'username'} maxLength={254}
      error={field(fields.email)} help={t('emailHelp')} isRequired/>
    <TextInput label={t('password')} type="password" value={values.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password webauthn' : 'new-password'} maxLength={256}
      error={field(fields.password)} help={mode === 'login' ? undefined : t('passwordHelp')} isRequired/>
    {mode === 'login' && cfg?.passwordReset && <NextLink href="/forgot-password" className="-mt-2 self-end text-sm text-accent hover:underline">{t('forgot')}</NextLink>}
    {captcha.element}
    {captcha.failed && <Notice tone="warning">{t('captchaLoadFailed')}</Notice>}
    <AnimatePresence>{failure && <motion.div role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}><Notice tone="danger">{failure}</Notice></motion.div>}</AnimatePresence>
    <Button type="submit" size="lg" fullWidth isPending={busy === 'password'} isDisabled={!!busy}>
      {busy === 'password' ? t('working') : t(`${mode}Submit`)}{mode === 'login' && lastMethod === 'email' && lastBadge}
    </Button>
    {mode === 'login' && <>
      <div className="flex items-center gap-3 text-xs text-muted"><Separator className="flex-1"/>{t('or')}<Separator className="flex-1"/></div>
      <Button variant="secondary" size="lg" fullWidth isPending={busy === 'passkey'} isDisabled={!!busy} onPress={passkey}>
        <I name="fingerprint" size={18}/>{t('passkeySignIn')}{lastMethod === 'passkey' && lastBadge}
      </Button>
    </>}
  </form>;
}

// The second step after a correct password: authenticator app, a code by SMS/e-mail, or a backup code.
function SecondFactor({ onBack }: { onBack: () => void }) {
  const t = useTranslations('Auth');
  const { error } = useErrorText();
  const router = useRouter();
  const [method, setMethod] = useState<'totp' | 'otp' | 'backup'>('totp');
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  async function send() {
    setFailure(undefined); setBusy(true);
    const { error: e } = await authClient.twoFactor.sendOtp();
    setBusy(false);
    if (e) setFailure(error(asApiError(e))); else setSent(true);
  }
  async function verify(e?: React.FormEvent) {
    e?.preventDefault();
    if (!code.trim()) return;
    setFailure(undefined); setBusy(true);
    const r = method === 'totp' ? await authClient.twoFactor.verifyTotp({ code, trustDevice: trust })
      : method === 'otp' ? await authClient.twoFactor.verifyOtp({ code, trustDevice: trust })
      : await authClient.twoFactor.verifyBackupCode({ code: code.trim(), trustDevice: trust });
    setBusy(false);
    if (r.error) { setFailure(error(asApiError(r.error))); setCode(''); return; }
    await landed(router);
  }
  const otp = (n: number) => <InputOTP maxLength={n} value={code} onChange={setCode} onComplete={() => void verify()} aria-label={t('twoFactor.code')} autoFocus>
    <InputOTP.Group>{[...Array(n)].map((_, i) => <InputOTP.Slot key={i} index={i}/>)}</InputOTP.Group>
  </InputOTP>;

  return <motion.form initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} onSubmit={verify} className="flex flex-col gap-5" noValidate>
    <div className="flex items-center gap-3">
      <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent"><I name="shield-check" size={20}/></span>
      <div><p className="font-semibold">{t('twoFactor.title')}</p><p className="text-sm text-muted">{t('twoFactor.intro')}</p></div>
    </div>
    <Tabs selectedKey={method} onSelectionChange={(k) => { setMethod(k as 'totp'); setCode(''); setFailure(undefined); }}>
      <Tabs.ListContainer><Tabs.List aria-label={t('twoFactor.title')}>
        <Tabs.Tab id="totp">{t('twoFactor.app')}<Tabs.Indicator/></Tabs.Tab>
        <Tabs.Tab id="otp">{t('twoFactor.sendCode')}<Tabs.Indicator/></Tabs.Tab>
        <Tabs.Tab id="backup">{t('twoFactor.backup')}<Tabs.Indicator/></Tabs.Tab>
      </Tabs.List></Tabs.ListContainer>
      <Tabs.Panel id="totp" className="flex flex-col items-center gap-3 pt-4"><p className="text-sm text-muted">{t('twoFactor.appHelp')}</p>{otp(6)}</Tabs.Panel>
      <Tabs.Panel id="otp" className="flex flex-col items-center gap-3 pt-4">
        <p className="text-sm text-muted">{sent ? t('twoFactor.codeSent') : t('twoFactor.codeHelp')}</p>
        {sent ? otp(6) : <Button variant="secondary" isPending={busy} onPress={send}><I name="send" size={16}/>{t('twoFactor.send')}</Button>}
        {sent && <Button size="sm" variant="ghost" isDisabled={busy} onPress={send}>{t('twoFactor.resend')}</Button>}
      </Tabs.Panel>
      <Tabs.Panel id="backup" className="pt-4"><TextInput label={t('twoFactor.backupLabel')} value={code} onChange={setCode} autoComplete="one-time-code" spellCheck={false} help={t('twoFactor.backupHelp')}/></Tabs.Panel>
    </Tabs>
    <CheckboxInput label={t('twoFactor.trust')} isSelected={trust} onChange={setTrust} help={t('twoFactor.trustHelp')}/>
    {failure && <div role="alert"><Notice tone="danger">{failure}</Notice></div>}
    <Button type="submit" size="lg" fullWidth isPending={busy} isDisabled={!code.trim()}>{t('twoFactor.verify')}</Button>
    <Button variant="ghost" onPress={onBack}><I name="arrow-left" size={16}/>{t('twoFactor.back')}</Button>
  </motion.form>;
}
