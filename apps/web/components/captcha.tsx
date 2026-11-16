"use client";
// One captcha widget for every provider the admin can pick: Cloudflare Turnstile, Google reCAPTCHA v2
// (checkbox) and v3 (invisible, scored) and hCaptcha. Forms call getToken() right before submitting.
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile';
import { useLocale } from 'next-intl';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptchaConfig } from '../lib/session';

type Grecaptcha = { ready: (cb: () => void) => void; render: (el: HTMLElement, o: object) => number; reset: (id?: number) => void; execute: (key: string, o: { action: string }) => Promise<string> };
type Hcaptcha = { render: (el: HTMLElement, o: object) => string; reset: (id?: string) => void };
declare global { interface Window { grecaptcha?: Grecaptcha; hcaptcha?: Hcaptcha } }

const loaded = new Map<string, Promise<void>>();
function loadScript(src: string) {
  if (!loaded.has(src)) loaded.set(src, new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.defer = true;
    s.onload = () => resolve(); s.onerror = () => { loaded.delete(src); reject(new Error('captcha script')); };
    document.head.appendChild(s);
  }));
  return loaded.get(src)!;
}

// Returns the widget to render (nothing for reCAPTCHA v3) and getToken() for the submit handler.
export function useCaptcha(config: Pick<CaptchaConfig, 'provider' | 'siteKey'> | null | undefined, action: string) {
  const locale = useLocale();
  const { resolvedTheme } = useTheme();
  const [token, setToken] = useState<string>();
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<number | string | undefined>(undefined);
  const turnstile = useRef<TurnstileInstance | undefined>(undefined);
  const provider = config?.provider;
  const siteKey = config?.siteKey;
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light';

  useEffect(() => {
    setToken(undefined); setFailed(false);
    if (!provider || !siteKey || provider === 'turnstile') return;
    let alive = true;
    const opts = { sitekey: siteKey, theme, callback: (t: string) => alive && setToken(t), 'expired-callback': () => alive && setToken(undefined), 'error-callback': () => alive && setFailed(true) };
    if (provider === 'recaptcha-v3') { loadScript(`https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}&hl=${locale}`).catch(() => setFailed(true)); return () => { alive = false; }; }
    const src = provider === 'hcaptcha' ? `https://js.hcaptcha.com/1/api.js?render=explicit&hl=${locale}` : `https://www.google.com/recaptcha/api.js?render=explicit&hl=${locale}`;
    loadScript(src).then(() => {
      const el = box.current;
      if (!alive || !el) return;
      el.innerHTML = '';
      const target = el.appendChild(document.createElement('div'));
      if (provider === 'hcaptcha') widget.current = window.hcaptcha!.render(target, opts);
      else window.grecaptcha!.ready(() => { if (alive) widget.current = window.grecaptcha!.render(target, opts); });
    }).catch(() => setFailed(true));
    return () => { alive = false; };
  }, [provider, siteKey, locale, theme]);

  const getToken = useCallback(async (): Promise<string | undefined> => {
    if (!provider || !siteKey) return undefined;
    if (provider === 'recaptcha-v3') {
      await loadScript(`https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}&hl=${locale}`);
      return new Promise((resolve) => window.grecaptcha!.ready(() => window.grecaptcha!.execute(siteKey, { action }).then(resolve, () => resolve(undefined))));
    }
    return token;
  }, [provider, siteKey, token, action, locale]);

  // After a failed submit a token is spent; the widget asks again.
  const reset = useCallback(() => {
    setToken(undefined);
    if (provider === 'turnstile') turnstile.current?.reset();
    else if (provider === 'hcaptcha') window.hcaptcha?.reset(widget.current as string);
    else if (provider === 'recaptcha-v2') window.grecaptcha?.reset(widget.current as number);
  }, [provider]);

  const element = !provider || !siteKey || provider === 'recaptcha-v3' ? null
    : provider === 'turnstile' ? <Turnstile ref={turnstile} key={siteKey} siteKey={siteKey} onSuccess={setToken} onExpire={() => setToken(undefined)} onError={() => setFailed(true)}
      options={{ language: locale, theme: 'auto', size: 'flexible' }}/>
    : <div ref={box} className="min-h-[78px]"/>;
  return { element, getToken, reset, ready: provider === 'recaptcha-v3' || !!token, failed, active: !!provider && !!siteKey };
}
