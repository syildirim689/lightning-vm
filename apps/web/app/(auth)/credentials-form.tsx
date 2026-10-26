"use client";
import { Button, Chip, InputOTP, Meter, Separator } from '@heroui/react';
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from 'motion/react';
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

// A rough strength score (0-4) for the registration form; the API only enforces the length.
export function passwordScore(p: string) {
  if (!p) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  const common = /^(password|parola|qwerty|123456|admin)/i.test(p) || /(.)\1{3,}/.test(p);
  return common ? 1 : Math.min(4, (p.length >= 12 ? 1 : 0) + (p.length >= 16 ? 1 : 0) + (classes >= 3 ? 1 : 0) + (classes === 4 || p.length >= 20 ? 1 : 0));
}

// Common e-mail domain typos ("gmial.com") get a one-click suggestion.
const domains = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'yandex.com', 'proton.me'];
export function emailSuggestion(email: string) {
  const [user, domain] = email.toLowerCase().split('@');
  if (!user || !domain || !domain.includes('.') || domains.includes(domain)) return null;
  const sorted = (x: string) => [...x].sort().join('');
  const near = domains.find((d) => {
    if (Math.abs(d.length - domain.length) > 1) return false;
    if (sorted(d) === sorted(domain)) return true;
    let diff = 0;
    for (let i = 0; i < Math.max(d.length, domain.length); i++) if (d[i] !== domain[i]) diff++;
    return diff === 1;
  });
  return near ? `${user}@${near}` : null;
}

// Password field with show/hide and a Caps Lock warning.
function PasswordField({ label, value, onChange, error, help, autoComplete }: { label: string; value: string; onChange: (v: string) => void; error?: string; help?: string; autoComplete: string }) {
  const t = useTranslations('Auth');
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const capsState = (e: React.KeyboardEvent) => setCaps(e.getModifierState?.('CapsLock') ?? false);
  return <div className="relative" onKeyUp={capsState} onKeyDown={capsState}>
    <TextInput label={label} type={shown ? 'text' : 'password'} value={value} onChange={onChange} autoComplete={autoComplete} maxLength={256} error={error}
      help={caps ? t('capsLock') : help} isRequired spellCheck={false}/>
    <button type="button" onClick={() => setShown((v) => !v)} aria-pressed={shown}
      className="absolute right-2 top-[1.95rem] grid h-8 min-w-8 place-items-center rounded-lg px-2 text-xs font-medium text-muted hover:bg-default hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent">
      <span className="flex items-center gap-1"><I name={shown ? 'eye-off' : 'eye'} size={16}/><span className="sr-only sm:not-sr-only">{shown ? t('hide') : t('show')}</span></span>
    </button>
  </div>;
}

function Strength({ password }: { password: string }) {
  const t = useTranslations('Auth');
  const score = passwordScore(password);
  const rules = [{ ok: password.length >= 12, text: t('rules.length') }, { ok: /[a-z]/.test(password) && /[A-Z]/.test(password), text: t('rules.case') },
    { ok: /\d/.test(password), text: t('rules.digit') }, { ok: /[^A-Za-z0-9]/.test(password), text: t('rules.symbol') }];
  if (!password) return null;
  return <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="-mt-2 flex flex-col gap-2">
    <Meter aria-label={t('strength')} value={score * 25} size="sm" color={score <= 1 ? 'danger' : score === 2 ? 'warning' : 'success'}>
      <Meter.Track><Meter.Fill/></Meter.Track>
    </Meter>
    <p className="text-xs text-muted" aria-live="polite">{t('strength')}: <span className="font-medium text-foreground">{t(`levels.${score}` as 'levels.0')}</span></p>
    <ul className="grid grid-cols-2 gap-1 text-xs">
      {rules.map((r) => <li key={r.text} className={`flex items-center gap-1.5 ${r.ok ? 'text-success' : 'text-muted'}`}>
        <I name={r.ok ? 'circle-check' : 'circle'} size={13}/>{r.text}</li>)}
    </ul>
  </motion.div>;
}

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
  const [emailCode, setEmailCode] = useState(false);
  const [lastMethod, setLastMethod] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [done, setDone] = useState(false);
  // Before hydration a click would submit the bare HTML form (GET /login?) and lose what was typed.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const shake = useAnimationControls();
  const still = useReducedMotion();
  const shakeForm = () => { if (!still) void shake.start({ x: [0, -8, 8, -6, 6, 0], transition: { duration: 0.4 } }); };
  const suggestion = mode !== 'setup' ? emailSuggestion(values.email) : null;
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
        ? await authClient.signIn.email({ email: values.email, password: values.password, rememberMe: remember, fetchOptions })
        : await authClient.signUp.email({ email: values.email, password: values.password, name: '', locale, fetchOptions } as Parameters<typeof authClient.signUp.email>[0]);
      if (res.error) { setFailure(error(asApiError(res.error))); shakeForm(); captcha.reset(); return; }
      if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) { setSecondStep(true); return; }
      setDone(true);
      await landed(router);
    } catch (err) {
      const apiErr = err as ApiError;
      setFields(apiErr.fields ?? {}); setFailure(error(apiErr)); shakeForm();
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
  if (emailCode) return <EmailCode initialEmail={values.email} onBack={() => setEmailCode(false)}/>;
  const lastBadge = <Chip size="sm" variant="soft" color="accent">{t('lastUsed')}</Chip>;
  return <motion.form method="post" animate={shake} onSubmit={submit} noValidate className="flex flex-col gap-4">
    {mode === 'setup' && !noToken && <TextInput label={t('token')} type="password" value={values.token} onChange={set('token')} autoComplete="one-time-code" spellCheck={false} help={t('tokenHelp')} isRequired/>}
    <TextInput label={t('email')} type="email" value={values.email} onChange={set('email')} autoComplete={mode === 'login' ? 'username webauthn' : 'username'} maxLength={254}
      error={field(fields.email)} help={t('emailHelp')} isRequired/>
    {suggestion && <button type="button" onClick={() => set('email')(suggestion)} className="-mt-2 self-start text-left text-xs text-accent hover:underline">{t('didYouMean', { email: suggestion })}</button>}
    <PasswordField label={t('password')} value={values.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password webauthn' : 'new-password'}
      error={field(fields.password)} help={mode === 'login' ? undefined : t('passwordHelp')}/>
    {mode !== 'login' && <Strength password={values.password}/>}
    {mode === 'login' && <div className="-mt-1 flex flex-wrap items-center justify-between gap-2">
      <CheckboxInput label={t('remember')} isSelected={remember} onChange={setRemember}/>
      {cfg?.passwordReset && <NextLink href="/forgot-password" className="text-sm text-accent hover:underline">{t('forgot')}</NextLink>}
    </div>}
    {captcha.element}
    {captcha.failed && <Notice tone="warning">{t('captchaLoadFailed')}</Notice>}
    <AnimatePresence>{failure && <motion.div role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}><Notice tone="danger">{failure}</Notice></motion.div>}</AnimatePresence>
    <Button type="submit" size="lg" fullWidth isPending={busy === 'password' && !done} isDisabled={!hydrated || !!busy || done}>
      {done ? <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex items-center gap-2"><I name="circle-check" size={18}/>{t('redirecting')}</motion.span>
        : <>{busy === 'password' ? t('working') : t(`${mode}Submit`)}{mode === 'login' && lastMethod === 'email' && lastBadge}</>}
    </Button>
    {mode === 'login' && <>
      <div className="flex items-center gap-3 text-xs text-muted"><Separator className="flex-1"/>{t('or')}<Separator className="flex-1"/></div>
      <Button variant="secondary" size="lg" fullWidth isPending={busy === 'passkey'} isDisabled={!!busy} onPress={passkey}>
        <I name="fingerprint" size={18}/>{t('passkeySignIn')}{lastMethod === 'passkey' && lastBadge}
      </Button>
      {cfg?.emailCodeSignIn && <Button variant="tertiary" size="lg" fullWidth isDisabled={!!busy} onPress={() => setEmailCode(true)}>
        <I name="mail-check" size={18}/>{t('emailCode.button')}{lastMethod === 'email-otp' && lastBadge}
      </Button>}
    </>}
  </motion.form>;
}

// A resend button that waits out a cooldown, showing the seconds left.
function useCooldown(seconds: number) {
  const [left, setLeft] = useState(0);
  useEffect(() => { if (left <= 0) return; const id = setTimeout(() => setLeft((s) => s - 1), 1000); return () => clearTimeout(id); }, [left]);
  return { left, start: () => setLeft(seconds) };
}

function CodeInput({ value, onChange, onComplete, label, invalid }: { value: string; onChange: (v: string) => void; onComplete: () => void; label: string; invalid?: boolean }) {
  return <InputOTP maxLength={6} value={value} onChange={onChange} onComplete={onComplete} aria-label={label} autoFocus isInvalid={invalid}>
    <InputOTP.Group>{[0, 1, 2].map((i) => <InputOTP.Slot key={i} index={i}/>)}</InputOTP.Group>
    <InputOTP.Separator/>
    <InputOTP.Group>{[3, 4, 5].map((i) => <InputOTP.Slot key={i} index={i}/>)}</InputOTP.Group>
  </InputOTP>;
}

const methodKey = 'lvm-2fa-method';

// The second step after a correct password: authenticator app, a code by SMS/e-mail, or a backup code.
function SecondFactor({ onBack }: { onBack: () => void }) {
  const t = useTranslations('Auth');
  const { error } = useErrorText();
  const router = useRouter();
  const cfg = useApiQuery<PublicConfig>(['public-config'], '/public/config').data;
  const otpAvailable = !!cfg && (cfg.otpChannels.sms || cfg.otpChannels.email);
  const [method, setMethod] = useState<'totp' | 'otp' | 'backup'>('totp');
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [done, setDone] = useState(false);
  const cooldown = useCooldown(60);
  const shake = useAnimationControls();
  const still = useReducedMotion();
  // The method used last time on this browser comes first.
  useEffect(() => { try { const m = localStorage.getItem(methodKey); if (m === 'otp' || m === 'backup' || m === 'totp') setMethod(m); } catch { /* storage off */ } }, []);
  const choose = (m: 'totp' | 'otp' | 'backup') => { setMethod(m); setCode(''); setFailure(undefined); try { localStorage.setItem(methodKey, m); } catch { /* storage off */ } };

  async function send() {
    setFailure(undefined); setBusy(true);
    const { error: e } = await authClient.twoFactor.sendOtp();
    setBusy(false);
    if (e) setFailure(error(asApiError(e))); else { setSent(true); cooldown.start(); }
  }
  async function verify(e?: React.FormEvent) {
    e?.preventDefault();
    if (!code.trim() || busy) return;
    setFailure(undefined); setBusy(true);
    const r = method === 'totp' ? await authClient.twoFactor.verifyTotp({ code, trustDevice: trust })
      : method === 'otp' ? await authClient.twoFactor.verifyOtp({ code, trustDevice: trust })
      : await authClient.twoFactor.verifyBackupCode({ code: code.trim(), trustDevice: trust });
    setBusy(false);
    if (r.error) {
      setFailure(error(asApiError(r.error))); setCode('');
      if (!still) void shake.start({ x: [0, -8, 8, -6, 6, 0], transition: { duration: 0.4 } });
      return;
    }
    setDone(true);
    await landed(router);
  }

  const tabs = [{ id: 'totp' as const, icon: 'smartphone', label: t('twoFactor.app') }, ...(otpAvailable ? [{ id: 'otp' as const, icon: 'message-square-text', label: t('twoFactor.sendCode') }] : []),
    { id: 'backup' as const, icon: 'key-round', label: t('twoFactor.backup') }];
  return <motion.form animate={shake} onSubmit={verify} className="flex flex-col gap-5" noValidate>
    <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-3">
      <motion.span aria-hidden className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent"
        animate={still ? undefined : { rotate: [0, -8, 8, 0] }} transition={{ duration: 0.6, delay: 0.2 }}><I name="shield-check" size={22}/></motion.span>
      <div><p className="font-semibold">{t('twoFactor.title')}</p><p className="text-sm text-muted">{t('twoFactor.intro')}</p></div>
    </motion.div>
    <div role="tablist" aria-label={t('twoFactor.title')} className="grid rounded-2xl bg-default p-1" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
      {tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={method === tab.id} onClick={() => choose(tab.id)}
        className="relative flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent sm:text-sm">
        {method === tab.id && <motion.span layoutId="tf-tab" className="absolute inset-0 rounded-xl bg-surface shadow-sm" transition={{ type: 'spring', stiffness: 380, damping: 32 }}/>}
        <span className={`relative flex items-center gap-1.5 ${method === tab.id ? 'text-foreground' : 'text-muted'}`}>
          <I name={{ totp: 'smartphone', otp: 'message-square-text', backup: 'key-round' }[tab.id]} size={15}/>{tab.label}</span>
      </button>)}
    </div>
    <AnimatePresence mode="wait">
      <motion.div key={method} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }} className="flex flex-col items-center gap-3">
        {method === 'totp' && <><p className="text-center text-sm text-muted">{t('twoFactor.appHelp')}</p>
          <CodeInput value={code} onChange={setCode} onComplete={() => void verify()} label={t('twoFactor.code')} invalid={!!failure}/></>}
        {method === 'otp' && <>
          <p className="text-center text-sm text-muted">{sent ? t('twoFactor.codeSentTo', { channel: cfg?.otpChannels.sms ? t('twoFactor.channelSms') : t('twoFactor.channelEmail') }) : t('twoFactor.codeHelp')}</p>
          {sent ? <CodeInput value={code} onChange={setCode} onComplete={() => void verify()} label={t('twoFactor.code')} invalid={!!failure}/>
            : <Button variant="secondary" isPending={busy} onPress={send}><I name="send" size={16}/>{t('twoFactor.send')}</Button>}
          {sent && <Button size="sm" variant="ghost" isDisabled={busy || cooldown.left > 0} onPress={send}>
            <I name="rotate-ccw" size={14}/>{cooldown.left > 0 ? t('twoFactor.resendIn', { s: cooldown.left }) : t('twoFactor.resend')}</Button>}
        </>}
        {method === 'backup' && <div className="w-full"><TextInput label={t('twoFactor.backupLabel')} value={code} onChange={setCode} autoComplete="one-time-code" spellCheck={false} help={t('twoFactor.backupHelp')}/></div>}
      </motion.div>
    </AnimatePresence>
    <CheckboxInput label={t('twoFactor.trust')} isSelected={trust} onChange={setTrust} help={t('twoFactor.trustHelp')}/>
    <AnimatePresence>{failure && <motion.div role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}><Notice tone="danger">{failure}</Notice></motion.div>}</AnimatePresence>
    <Button type="submit" size="lg" fullWidth isPending={busy && !done} isDisabled={!code.trim() || done}>
      {done ? <span className="flex items-center gap-2"><I name="circle-check" size={18}/>{t('redirecting')}</span> : t('twoFactor.verify')}</Button>
    <p className="text-center text-xs text-muted">{t('twoFactor.lost')}</p>
    <Button variant="ghost" onPress={onBack}><I name="arrow-left" size={16}/>{t('twoFactor.back')}</Button>
  </motion.form>;
}

// Sign-in with a one-time code sent by e-mail (when the admin allows it); accounts with two-factor use their password.
function EmailCode({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const t = useTranslations('Auth');
  const { error, field } = useErrorText();
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [emailError, setEmailError] = useState<string>();
  const cooldown = useCooldown(60);
  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!z.string().email().safeParse(email).success) { setEmailError(field('INVALID_EMAIL')); return; }
    setFailure(undefined); setBusy(true);
    const r = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
    setBusy(false);
    if (r.error) { setFailure(error(asApiError(r.error))); return; }
    setSent(true); cooldown.start();
  }
  async function verify() {
    if (code.length !== 6 || busy) return;
    setFailure(undefined); setBusy(true);
    const r = await authClient.signIn.emailOtp({ email, otp: code });
    setBusy(false);
    if (r.error) { setFailure(error(asApiError(r.error))); setCode(''); return; }
    await landed(router);
  }
  return <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col gap-4">
    <div className="flex items-center gap-3">
      <span aria-hidden className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent"><I name="mail-check" size={22}/></span>
      <div><p className="font-semibold">{t('emailCode.title')}</p><p className="text-sm text-muted">{sent ? t('emailCode.sent', { email }) : t('emailCode.intro')}</p></div>
    </div>
    {!sent ? <form className="flex flex-col gap-4" noValidate onSubmit={send}>
      <TextInput label={t('email')} type="email" value={email} onChange={(v) => { setEmail(v); setEmailError(undefined); }} autoComplete="username" error={emailError} isRequired/>
      <Button type="submit" size="lg" fullWidth isPending={busy}><I name="send" size={16}/>{t('emailCode.send')}</Button>
    </form> : <div className="flex flex-col items-center gap-3">
      <CodeInput value={code} onChange={setCode} onComplete={() => void verify()} label={t('twoFactor.code')} invalid={!!failure}/>
      <Button size="lg" fullWidth isPending={busy} isDisabled={code.length !== 6} onPress={verify}>{t('emailCode.verify')}</Button>
      <Button size="sm" variant="ghost" isDisabled={busy || cooldown.left > 0} onPress={() => void send()}>
        <I name="rotate-ccw" size={14}/>{cooldown.left > 0 ? t('twoFactor.resendIn', { s: cooldown.left }) : t('twoFactor.resend')}</Button>
    </div>}
    <AnimatePresence>{failure && <motion.div role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}><Notice tone="danger">{failure}</Notice></motion.div>}</AnimatePresence>
    <Button variant="ghost" onPress={onBack}><I name="arrow-left" size={16}/>{t('emailCode.back')}</Button>
  </motion.div>;
}
