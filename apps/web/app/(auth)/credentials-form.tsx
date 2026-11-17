"use client";
import { backTo } from '../../lib/back-to';
import { Button, InputOTP, Meter, Separator } from '@heroui/react';
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from 'motion/react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useCaptcha } from '../../components/captcha';
import { I } from '../../components/icon';
import { FailureGlow, SuccessOverlay } from './outcome';
import ProviderMark, { providerNames } from '../../components/provider-mark';
import { CheckboxInput, Notice, TextInput } from '../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../lib/api';
import { sessionEnded } from '../../lib/session-end';
import { authClient } from '../../lib/auth-client';
import { can } from '../../lib/permissions';
import { useApiQuery } from '../../lib/query';
import { strongPassword } from '../../lib/password';
import { copyText } from '../../lib/clipboard';
import type { PublicConfig, User } from '../../lib/session';

type Mode = 'login' | 'register' | 'setup';
export type { PublicConfig };

// Same limits as the API; the server stays the authority, this only answers early and in the user's language.
const schema = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(256) });
const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1) });
// With user names on, the first field takes either an e-mail address or a user name.
const usernamePattern = /^[a-z0-9][a-z0-9._-]{2,29}$/i;

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
// generate: offers a strong random password, shown and copied so it can go into a password manager.
export function PasswordField({ label, value, onChange, error, help, autoComplete, autofill, generate }: { label: string; value: string; onChange: (v: string) => void; error?: string; help?: string; autoComplete: string; autofill?: boolean; generate?: boolean }) {
  const t = useTranslations('Auth');
  const [shown, setShown] = useState(false);
  const [made, setMade] = useState<'copied' | 'shown'>();
  async function make() {
    const p = strongPassword();
    onChange(p); setShown(true);
    setMade(await copyText(p) ? 'copied' : 'shown');
  }
  const [caps, setCaps] = useState(false);
  const capsState = (e: React.KeyboardEvent) => setCaps(e.getModifierState?.('CapsLock') ?? false);
  return <div className="relative" onKeyUp={capsState} onKeyDown={capsState}>
    <TextInput label={label} type={shown ? 'text' : 'password'} value={value} onChange={onChange} autoComplete={autoComplete} autofill={autofill} maxLength={256} error={error}
      help={caps ? t('capsLock') : help} isRequired spellCheck={false}/>
    <button type="button" onClick={() => setShown((v) => !v)} aria-pressed={shown}
      className="absolute right-2 top-[1.95rem] grid h-8 min-w-8 place-items-center rounded-lg px-2 text-xs font-medium text-muted hover:bg-default hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent">
      <span className="flex items-center gap-1"><I name={shown ? 'eye-off' : 'eye'} size={16}/><span className="sr-only sm:not-sr-only">{shown ? t('hide') : t('show')}</span></span>
    </button>
    {generate && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button size="sm" variant="secondary" onPress={make}><I name="wand-sparkles" size={15}/>{t('generate')}</Button>
      {made && value && <span role="status" className="flex items-center gap-1 text-xs text-success"><I name="circle-check" size={13}/>{t(made === 'copied' ? 'generatedCopied' : 'generatedShown')}</span>}
    </div>}
  </div>;
}

export function Strength({ password }: { password: string }) {
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

// Where a provider or a sign-in link brings the person back to.
const here = () => backTo(new URLSearchParams(window.location.search).get('next')) ?? '/';

// A full page load, not a client navigation: nothing cached for whoever used this browser before is carried over.
export async function landed(_router?: ReturnType<typeof useRouter>) {
  const me = await apiFetch<User>('/auth/me');
  // Back to the page the person was sent away from, else their start page.
  window.location.assign(backTo(new URLSearchParams(window.location.search).get('next')) ?? (can(me.permissions, 'dashboard.view') ? '/admin' : '/'));
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
  const [busy, setBusy] = useState<string>();
  const [linkMode, setLinkMode] = useState(false);
  const [secondStep, setSecondStep] = useState<boolean | string[]>(false);
  const [emailCode, setEmailCode] = useState(false);
  const [lastMethod, setLastMethod] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [done, setDone] = useState(false);
  // Before hydration a click would submit the bare HTML form (GET /login?) and lose what was typed.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const shake = useAnimationControls();
  const still = useReducedMotion();
  const [failures, setFailures] = useState(0);
  const shakeForm = () => { setFailures((n) => n + 1); if (!still) void shake.start({ x: [0, -8, 8, -6, 6, 0], transition: { duration: 0.4 } }); };
  const suggestion = mode !== 'setup' ? emailSuggestion(values.email) : null;
  const set = (k: keyof typeof values) => (v: string) => { setValues((x) => ({ ...x, [k]: v })); setFields((f) => ({ ...f, [k]: '' })); };
  const form = mode === 'login' ? 'signIn' : 'signUp';
  const captcha = useCaptcha(mode !== 'setup' && cfg?.captcha?.use[form] ? cfg.captcha : null, mode === 'login' ? 'login' : 'signup');

  useEffect(() => { if (mode === 'login') setLastMethod(authClient.getLastUsedLoginMethod?.() ?? null); }, [mode]);
  // The sign-in page with nobody signed in: whatever the last person left in this browser (drafts, recent servers,
  // their push subscription) goes now. This also covers a session the server found gone on a page load.
  useEffect(() => { if (mode === 'login') apiFetch('/auth/me').catch((e: ApiError) => { if (e?.code === 'UNAUTHENTICATED') void sessionEnded(); }); }, [mode]);

  // Passkeys offered by the browser's autofill on the e-mail field (conditional mediation), where supported.
  useEffect(() => {
    if (mode !== 'login' || typeof window === 'undefined' || !window.PublicKeyCredential?.isConditionalMediationAvailable) return;
    let active = true;
    window.PublicKeyCredential.isConditionalMediationAvailable().then((ok) => {
      if (ok && active) void authClient.signIn.passkey({ autoFill: true }).then(({ error: e }) => { if (!e && active) void landed(router); });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Google One Tap (when the admin turned it on): Google's prompt, then back here signed in. Its client is made
  // only here, since it needs the Google client id from the public settings.
  const oneTapId = mode === 'login' ? cfg?.signIn?.oneTap?.clientId : undefined;
  useEffect(() => {
    if (!oneTapId) return;
    let stop = false;
    void Promise.all([import('better-auth/react'), import('better-auth/client/plugins')]).then(([{ createAuthClient }, { oneTapClient }]) => {
      if (stop) return;
      const c = createAuthClient({ basePath: '/api/auth', fetchOptions: { headers: { 'x-lightning-csrf': '1' } }, plugins: [oneTapClient({ clientId: oneTapId, promptOptions: { maxAttempts: 1 } })] });
      void c.oneTap({ callbackURL: '/' }).catch(() => undefined);
    });
    return () => { stop = true; };
  }, [oneTapId]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFailure(undefined);
    const byName = mode === 'login' && !!cfg?.signIn?.username && !values.email.includes('@');
    const parsed = byName ? (usernamePattern.test(values.email) && values.password ? { success: true as const } : { success: false as const, error: { issues: [{ path: [values.password ? 'email' : 'password'], code: 'custom' }] } })
      : (mode === 'login' ? loginSchema : schema).safeParse(values);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const k = String(issue.path[0]);
        next[k] = k === 'email' ? (byName ? 'INVALID_USERNAME' : 'INVALID_EMAIL') : issue.code === 'too_big' ? 'PASSWORD_TOO_LONG' : mode === 'login' ? 'REQUIRED' : 'PASSWORD_TOO_SHORT';
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
      const res = byName ? await authClient.signIn.username({ username: values.email.trim().toLowerCase(), password: values.password, rememberMe: remember, fetchOptions })
        : mode === 'login'
        ? await authClient.signIn.email({ email: values.email, password: values.password, rememberMe: remember, fetchOptions })
        : await authClient.signUp.email({ email: values.email, password: values.password, name: '', locale, fetchOptions } as Parameters<typeof authClient.signUp.email>[0]);
      if (res.error) { setFailure(error(asApiError(res.error))); shakeForm(); captcha.reset(); return; }
      const second = res.data as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] } | null;
      if (second?.twoFactorRedirect) { setSecondStep(second.twoFactorMethods ?? true); return; }
      setDone(true);
      await landed(router);
    } catch (err) {
      const apiErr = err as ApiError;
      setFields(apiErr.fields ?? {}); setFailure(error(apiErr)); shakeForm();
    } finally { setBusy(undefined); }
  }

  // Single sign-on: the API answers with the provider's sign-in page; the provider sends the person back signed in.
  async function sso() {
    setFailure(undefined); setBusy('sso');
    try {
      const r = await apiFetch<{ url: string }>('/auth/sign-in/social', { method: 'POST', body: { provider: 'oidc', callbackURL: here(), errorCallbackURL: '/login?reason=sso' } });
      window.location.assign(r.url);
    } catch (e) { setBusy(undefined); setFailure(error(e)); shakeForm(); }
  }

  // A social provider: the browser goes to the provider and comes back signed in (or with the reason it failed).
  async function social(provider: string) {
    setFailure(undefined); setBusy(provider);
    const { error: err } = await authClient.signIn.social({ provider, callbackURL: here(), errorCallbackURL: '/login?reason=sso' });
    if (err) { setBusy(undefined); setFailure(error(asApiError(err))); shakeForm(); }
  }

  async function passkey() {
    setFailure(undefined); setBusy('passkey');
    const { error: err } = await authClient.signIn.passkey();
    setBusy(undefined);
    if (err) { if (asApiError(err).code !== 'AUTH_CANCELLED') { setFailure(error(asApiError(err))); shakeForm(); } return; }
    setDone(true);
    await landed(router);
  }

  // Registration closed (when the API says so in /public/config): say so instead of a form that is always refused.
  if (mode === 'register' && cfg?.registration === false) return <div className="flex flex-col gap-4">
    <Notice tone="default" title={t('registrationClosed')}>{t('registrationClosedHelp')}</Notice>
    <NextLink href="/login" className="text-sm font-medium text-accent hover:underline">{t('loginTitle')}</NextLink>
  </div>;
  if (secondStep) return <SecondFactor methods={Array.isArray(secondStep) ? secondStep : undefined} onBack={() => setSecondStep(false)}/>;
  if (emailCode) return <EmailCode initialEmail={values.email} onBack={() => setEmailCode(false)}/>;
  if (linkMode) return <MagicLink initialEmail={values.email.includes('@') ? values.email : ''} onBack={() => setLinkMode(false)}/>;
  // The method used last time: a small tag on the button's top edge, readable on any button colour.
  const withLast = (on: boolean, button: React.ReactNode) => <div className="relative">{button}
    {on && <span className="pointer-events-none absolute -top-2.5 right-4 inline-flex items-center gap-1 rounded-full border border-accent/40 bg-surface px-2 py-0.5 text-[11px] font-semibold text-accent shadow-sm">
      <I name="history" size={11}/>{t('lastUsed')}</span>}
  </div>;
  return <motion.form method="post" animate={shake} onSubmit={submit} noValidate className="relative flex flex-col gap-4">
    <FailureGlow count={failures}/>
    <SuccessOverlay show={done} label={t('redirecting')}/>
    {mode === 'setup' && !noToken && <TextInput label={t('token')} type="password" value={values.token} onChange={set('token')} autoComplete="one-time-code" spellCheck={false} help={t('tokenHelp')} isRequired/>}
    <TextInput label={mode === 'login' && cfg?.signIn?.username ? t('emailOrUsername') : t('email')} type={mode === 'login' && cfg?.signIn?.username ? 'text' : 'email'} value={values.email} onChange={set('email')} autoComplete="username webauthn" autofill={mode === 'login'} maxLength={254}
      error={field(fields.email)} help={t('emailHelp')} isRequired/>
    {suggestion && <button type="button" onClick={() => set('email')(suggestion)} className="-mt-2 self-start text-left text-xs text-accent hover:underline">{t('didYouMean', { email: suggestion })}</button>}
    <PasswordField label={t('password')} value={values.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password webauthn' : 'new-password'} autofill={mode === 'login'}
      error={field(fields.password)} help={mode === 'login' ? undefined : t('passwordHelp')} generate={mode !== 'login'}/>
    {mode !== 'login' && <Strength password={values.password}/>}
    {mode === 'login' && <div className="-mt-1 flex flex-wrap items-center justify-between gap-2">
      <CheckboxInput label={t('remember')} isSelected={remember} onChange={setRemember}/>
      {cfg?.passwordReset && <NextLink href="/forgot-password" className="text-sm text-accent hover:underline">{t('forgot')}</NextLink>}
    </div>}
    {captcha.element}
    {captcha.failed && <Notice tone="warning">{t('captchaLoadFailed')}</Notice>}
    <AnimatePresence>{failure && <motion.div role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}><Notice tone="danger">{failure}</Notice></motion.div>}</AnimatePresence>
    {withLast(mode === 'login' && lastMethod === 'email', <Button type="submit" size="lg" fullWidth isPending={busy === 'password' && !done} isDisabled={!hydrated || !!busy || done}>
      {done ? <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex items-center gap-2"><I name="circle-check" size={18}/>{t('redirecting')}</motion.span>
        : busy === 'password' ? t('working') : t(`${mode}Submit`)}
    </Button>)}
    {mode === 'login' && <>
      <div className="flex items-center gap-3 text-xs text-muted"><Separator className="flex-1"/>{t('or')}<Separator className="flex-1"/></div>
      {withLast(lastMethod === 'passkey', <Button variant="secondary" size="lg" fullWidth isPending={busy === 'passkey'} isDisabled={!!busy} onPress={passkey}>
        <I name="fingerprint" size={18}/>{t('passkeySignIn')}
      </Button>)}
      {cfg?.sso && withLast(lastMethod === 'oidc', <Button variant="secondary" size="lg" fullWidth isPending={busy === 'sso'} isDisabled={!!busy} onPress={sso}>
        <I name="building-2" size={18}/>{t('ssoSignIn', { name: cfg.sso.name })}
      </Button>)}
      {!!cfg?.signIn?.social.length && <div className={`grid gap-2 ${cfg.signIn.social.length > 1 ? 'sm:grid-cols-2' : ''}`}>
        {cfg.signIn.social.map((p) => <div key={p}>{withLast(lastMethod === p, <Button variant="secondary" size="lg" fullWidth isPending={busy === p} isDisabled={!!busy} onPress={() => social(p)}>
          <ProviderMark id={p} size={18}/>{t('continueWith', { name: providerNames[p] ?? p })}
        </Button>)}</div>)}
      </div>}
      {cfg?.signIn?.magicLink && withLast(lastMethod === 'magic-link', <Button variant="tertiary" size="lg" fullWidth isDisabled={!!busy} onPress={() => setLinkMode(true)}>
        <I name="send" size={18}/>{t('magicLink.button')}
      </Button>)}
      {cfg?.emailCodeSignIn && withLast(lastMethod === 'email-otp', <Button variant="tertiary" size="lg" fullWidth isDisabled={!!busy} onPress={() => setEmailCode(true)}>
        <I name="mail-check" size={18}/>{t('emailCode.button')}
      </Button>)}
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
  return <div data-autofill="true"><InputOTP maxLength={6} value={value} onChange={onChange} onComplete={onComplete} aria-label={label} autoFocus isInvalid={invalid}>
    <InputOTP.Group>{[0, 1, 2].map((i) => <InputOTP.Slot key={i} index={i}/>)}</InputOTP.Group>
    <InputOTP.Separator/>
    <InputOTP.Group>{[3, 4, 5].map((i) => <InputOTP.Slot key={i} index={i}/>)}</InputOTP.Group>
  </InputOTP></div>;
}

const methodKey = 'lvm-2fa-method';

// The second step after a correct password: authenticator app, a code by SMS/e-mail, or a backup code.
// `methods` is what the account has (the app only once it was scanned and confirmed); unknown means all.
function SecondFactor({ methods, onBack }: { methods?: string[]; onBack: () => void }) {
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
  const [failures, setFailures] = useState(0);
  const cooldown = useCooldown(60);
  const shake = useAnimationControls();
  const still = useReducedMotion();
  const has = (m: string) => !methods || methods.includes(m);
  const tabs = [...(has('totp') ? [{ id: 'totp' as const, label: t('twoFactor.app') }] : []), ...(otpAvailable && has('otp') ? [{ id: 'otp' as const, label: t('twoFactor.sendCode') }] : []),
    { id: 'backup' as const, label: t('twoFactor.backup') }];
  const ids = tabs.map((x) => x.id).join();
  // The method used last time on this browser comes first, when this account has it; otherwise the first one it has.
  useEffect(() => {
    let m: string | null = null;
    try { m = localStorage.getItem(methodKey); } catch { /* storage off */ }
    const list = ids.split(',') as ('totp' | 'otp' | 'backup')[];
    setMethod(list.find((x) => x === m) ?? list[0]);
  }, [ids]);
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
      setFailure(error(asApiError(r.error))); setCode(''); setFailures((n) => n + 1);
      if (!still) void shake.start({ x: [0, -8, 8, -6, 6, 0], transition: { duration: 0.4 } });
      return;
    }
    setDone(true);
    await landed(router);
  }

  return <motion.form animate={shake} onSubmit={verify} className="relative flex flex-col gap-5" noValidate>
    <FailureGlow count={failures}/>
    <SuccessOverlay show={done} label={t('redirecting')}/>
    <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-3">
      <motion.span aria-hidden className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent"
        animate={still ? undefined : { rotate: [0, -8, 8, 0] }} transition={{ duration: 0.6, delay: 0.2 }}><I name="shield-check" size={22}/></motion.span>
      <div><p className="font-semibold">{t('twoFactor.title')}</p><p className="text-sm text-muted">{t('twoFactor.intro')}</p></div>
    </motion.div>
    <div role="tablist" aria-label={t('twoFactor.title')} className="grid rounded-2xl bg-default p-1" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
      {tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={method === tab.id} onClick={() => choose(tab.id)}
        className="relative flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent sm:text-sm">
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
        {method === 'backup' && <div className="w-full"><TextInput label={t('twoFactor.backupLabel')} value={code} onChange={setCode} autoComplete="one-time-code" autofill spellCheck={false} help={t('twoFactor.backupHelp')}/></div>}
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
  // Sending the code is protected like the sign-in form: the same captcha, asked again for every send.
  const cfg = useApiQuery<PublicConfig>(['public-config'], '/public/config').data;
  const captcha = useCaptcha(cfg?.captcha?.use.signIn ? cfg.captcha : null, 'login');
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
    try {
      const token = captcha.active ? await captcha.getToken() : undefined;
      if (captcha.active && !token) { setFailure(t('captchaRequired')); return; }
      const r = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in', fetchOptions: token ? { headers: { 'x-captcha-response': token } } : undefined });
      captcha.reset();
      if (r.error) { setFailure(error(asApiError(r.error))); return; }
      setSent(true); cooldown.start();
    } finally { setBusy(false); }
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
    {!sent ? <form id="email-code-form" className="flex flex-col gap-4" noValidate onSubmit={send}>
      <TextInput label={t('email')} type="email" value={email} onChange={(v) => { setEmail(v); setEmailError(undefined); }} autoComplete="username" error={emailError} isRequired/>
    </form> : <div className="flex flex-col items-center gap-3">
      <CodeInput value={code} onChange={setCode} onComplete={() => void verify()} label={t('twoFactor.code')} invalid={!!failure}/>
      <Button size="lg" fullWidth isPending={busy} isDisabled={code.length !== 6} onPress={verify}>{t('emailCode.verify')}</Button>
      <Button size="sm" variant="ghost" isDisabled={busy || cooldown.left > 0} onPress={() => void send()}>
        <I name="rotate-ccw" size={14}/>{cooldown.left > 0 ? t('twoFactor.resendIn', { s: cooldown.left }) : t('twoFactor.resend')}</Button>
    </div>}
    {/* One widget for the first send and for every resend: it stays where it is, so it can be asked again. */}
    {captcha.element}
    {captcha.failed && <Notice tone="warning">{t('captchaLoadFailed')}</Notice>}
    {!sent && <Button type="submit" form="email-code-form" size="lg" fullWidth isPending={busy}><I name="send" size={16}/>{t('emailCode.send')}</Button>}
    <AnimatePresence>{failure && <motion.div role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}><Notice tone="danger">{failure}</Notice></motion.div>}</AnimatePresence>
    <Button variant="ghost" onPress={onBack}><I name="arrow-left" size={16}/>{t('emailCode.back')}</Button>
  </motion.div>;
}

// "E-mail me a sign-in link": the API mails a one-time link (10 minutes) to existing accounts only; the answer
// is the same for every address, so nobody learns who has an account.
function MagicLink({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const t = useTranslations('Auth');
  const { error } = useErrorText();
  const cfg = useApiQuery<PublicConfig>(['public-config'], '/public/config').data;
  const captcha = useCaptcha(cfg?.captcha?.use.signIn ? cfg.captcha : null, 'login');
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string>();
  async function send(e?: React.FormEvent) {
    e?.preventDefault(); setFailure(undefined);
    if (!z.string().email().safeParse(email).success) { setFailure(error({ code: 'INVALID_EMAIL' })); return; }
    setBusy(true);
    try {
      const token = captcha.active ? await captcha.getToken() : undefined;
      const { error: err } = await authClient.signIn.magicLink({ email: email.trim().toLowerCase(), callbackURL: here(), errorCallbackURL: '/login?reason=link', fetchOptions: token ? { headers: { 'x-captcha-response': token } } : undefined });
      if (err) { setFailure(error(asApiError(err))); captcha.reset(); return; }
      setSent(true);
    } finally { setBusy(false); }
  }
  return <form onSubmit={send} noValidate className="flex flex-col gap-4">
    <AnimatePresence mode="wait">{sent
      ? <motion.div key="sent" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center gap-3 rounded-2xl border border-success/30 bg-success/5 px-4 py-6 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-success/15 text-success"><I name="mail-check" size={22}/></span>
          <p className="font-semibold">{t('magicLink.sentTitle')}</p>
          <p className="text-sm text-muted">{t('magicLink.sentBody', { email })}</p>
          <Button size="sm" variant="ghost" onPress={() => setSent(false)}>{t('magicLink.again')}</Button>
        </motion.div>
      : <motion.div key="ask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t('magicLink.intro')}</p>
          <TextInput label={t('email')} type="email" value={email} onChange={setEmail} autoComplete="email" autofill maxLength={254} isRequired/>
          {captcha.element}
          {failure && <Notice tone="danger">{failure}</Notice>}
          <Button type="submit" size="lg" fullWidth isPending={busy}><I name="send" size={18}/>{t('magicLink.send')}</Button>
        </motion.div>}</AnimatePresence>
    <Button variant="ghost" onPress={onBack}><I name="arrow-left" size={16}/>{t('magicLink.back')}</Button>
  </form>;
}
