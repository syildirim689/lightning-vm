"use client";
import { Button } from '@heroui/react';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useCaptcha } from '../../../components/captcha';
import { useState } from 'react';
import { z } from 'zod';
import { Notice, TextInput } from '../../../components/ui';
import { useErrorText } from '../../../lib/api';
import { authClient } from '../../../lib/auth-client';
import { useApiQuery } from '../../../lib/query';
import type { PublicConfig } from '../credentials-form';

// The answer is the same whether or not the address has an account, so this page reveals nothing.
export default function ForgotPassword() {
  const t = useTranslations('Auth');
  const { error, field } = useErrorText();
  const cfg = useApiQuery<PublicConfig>(['public-config'], '/public/config').data;
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string>();
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [failure, setFailure] = useState<string>();
  const captcha = useCaptcha(cfg?.captcha?.use.passwordReset ? cfg.captcha : null, 'password_reset');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setFailure(undefined);
    if (!z.string().email().safeParse(email).success) { setEmailError(field('INVALID_EMAIL')); return; }
    setState('busy');
    const token = captcha.active ? await captcha.getToken() : undefined;
    if (captcha.active && !token) { setFailure(t('captchaRequired')); setState('idle'); return; }
    const { error: err } = await authClient.requestPasswordReset({ email, redirectTo: '/reset-password',
      fetchOptions: token ? { headers: { 'x-captcha-response': token } } : undefined });
    if (err) { captcha.reset(); setFailure(error({ code: err.code ?? (err.status === 429 ? 'RATE_LIMITED' : 'UNKNOWN') })); setState('idle'); return; }
    setState('sent');
  }

  return <div className="w-full max-w-sm">
    <h1 className="text-2xl font-semibold tracking-tight">{t('forgotTitle')}</h1>
    <p className="mb-6 mt-1 text-sm text-muted">{t('forgotIntro')}</p>
    {cfg && !cfg.passwordReset ? <Notice tone="warning">{t('resetUnavailable')}</Notice>
      : state === 'sent' ? <div role="status"><Notice tone="success" title={t('resetSent')}/></div>
      : <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <TextInput label={t('email')} type="email" value={email} onChange={(v) => { setEmail(v); setEmailError(undefined); }} error={emailError} autoComplete="username" isRequired/>
          {captcha.element}
          {failure && <div role="alert"><Notice tone="danger">{failure}</Notice></div>}
          <Button type="submit" size="lg" fullWidth isPending={state === 'busy'}>{t('resetSend')}</Button>
        </form>}
    <p className="mt-6 text-center text-sm"><NextLink className="font-medium text-accent hover:underline" href="/login">{t('toLogin')}</NextLink></p>
  </div>;
}
