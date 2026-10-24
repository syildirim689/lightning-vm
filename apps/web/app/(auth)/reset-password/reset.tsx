"use client";
import { Button } from '@heroui/react';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { z } from 'zod';
import { Notice, TextInput } from '../../../components/ui';
import { useErrorText } from '../../../lib/api';
import { authClient } from '../../../lib/auth-client';

// Reached from the e-mailed link: better-auth checks the one-time token and redirects here with it.
export default function ResetPassword({ token, linkError }: { token: string; linkError?: string }) {
  const t = useTranslations('Auth');
  const { error, field } = useErrorText();
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [failure, setFailure] = useState<string>();
  const invalid = !token || !!linkError;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setFailure(undefined);
    const ok = z.string().min(12).max(256).safeParse(password);
    if (!ok.success) { setFieldError(field(password.length > 256 ? 'PASSWORD_TOO_LONG' : 'PASSWORD_TOO_SHORT')); return; }
    setState('busy');
    const { error: err } = await authClient.resetPassword({ newPassword: password, token });
    if (err) { setFailure(error({ code: err.code ?? 'UNKNOWN' })); setState('idle'); return; }
    setState('done');
  }

  return <div className="w-full max-w-sm">
    <h1 className="text-2xl font-semibold tracking-tight">{t('resetTitle')}</h1>
    <p className="mb-6 mt-1 text-sm text-muted">{t('resetIntro')}</p>
    {invalid ? <Notice tone="danger">{error({ code: 'INVALID_TOKEN' })}</Notice>
      : state === 'done' ? <div role="status"><Notice tone="success" title={t('resetDone')}/></div>
      : <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <TextInput label={t('newPassword')} type="password" value={password} onChange={(v) => { setPassword(v); setFieldError(undefined); }} error={fieldError} help={t('passwordHelp')} autoComplete="new-password" isRequired/>
          {failure && <div role="alert"><Notice tone="danger">{failure}</Notice></div>}
          <Button type="submit" size="lg" fullWidth isPending={state === 'busy'}>{t('resetSubmit')}</Button>
        </form>}
    <p className="mt-6 text-center text-sm"><NextLink className="font-medium text-accent hover:underline" href="/login">{t('toLogin')}</NextLink></p>
  </div>;
}
