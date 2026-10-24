"use client";
import { Button, toast } from '@heroui/react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useState } from 'react';
import { z } from 'zod';
import { I } from '../../../components/icon';
import { CheckboxInput, Notice, Section, StatusChip, TextInput } from '../../../components/ui';
import { useErrorText } from '../../../lib/api';
import { authClient } from '../../../lib/auth-client';

type ClientError = { code?: string; status?: number } | null;
const codeOf = (e: ClientError) => ({ code: e?.code ?? (e?.status === 429 ? 'RATE_LIMITED' : 'UNKNOWN') });

// Password, passkeys and signed-in devices; all handled by better-auth through its client.
export default function Security() {
  const t = useTranslations('Account');
  return <Section title={t('security.title')} description={t('security.intro')}>
    <div className="grid gap-8 xl:grid-cols-3">
      <ChangePassword/>
      <Passkeys/>
      <Sessions/>
    </div>
  </Section>;
}

function ChangePassword() {
  const t = useTranslations('Account');
  const ta = useTranslations('Auth');
  const { error, field } = useErrorText();
  const [v, setV] = useState({ current: '', next: '', others: true });
  const [fieldError, setFieldError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!z.string().min(12).max(256).safeParse(v.next).success) { setFieldError(field(v.next.length > 256 ? 'PASSWORD_TOO_LONG' : 'PASSWORD_TOO_SHORT')); return; }
    setBusy(true);
    const { error: err } = await authClient.changePassword({ currentPassword: v.current, newPassword: v.next, revokeOtherSessions: v.others });
    setBusy(false);
    if (err) { toast.danger(error(codeOf(err))); return; }
    setV({ current: '', next: '', others: true }); toast.success(t('security.passwordChanged'));
  }
  return <form onSubmit={submit} noValidate className="flex flex-col gap-4">
    <h3 className="font-semibold">{t('security.password')}</h3>
    <TextInput label={t('security.currentPassword')} type="password" value={v.current} onChange={(x) => setV((s) => ({ ...s, current: x }))} autoComplete="current-password" isRequired/>
    <TextInput label={ta('newPassword')} type="password" value={v.next} onChange={(x) => { setV((s) => ({ ...s, next: x })); setFieldError(undefined); }} error={fieldError} help={ta('passwordHelp')} autoComplete="new-password" isRequired/>
    <CheckboxInput label={t('security.signOutOthers')} isSelected={v.others} onChange={(x) => setV((s) => ({ ...s, others: x }))}/>
    <div><Button type="submit" variant="secondary" isPending={busy}>{t('security.changePassword')}</Button></div>
  </form>;
}

function Passkeys() {
  const t = useTranslations('Account');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const [listRef] = useAutoAnimate<HTMLUListElement>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useQuery({ queryKey: ['passkeys'], queryFn: async () => (await authClient.passkey.listUserPasskeys()).data ?? [] });
  const secure = typeof window === 'undefined' || window.isSecureContext;
  async function add() {
    setBusy(true);
    const res = await authClient.passkey.addPasskey({ name: name || undefined });
    setBusy(false);
    if (res?.error) { if (codeOf(res.error).code !== 'REGISTRATION_CANCELLED') toast.danger(error(codeOf(res.error))); return; }
    setName(''); toast.success(t('security.passkeyAdded')); client.invalidateQueries({ queryKey: ['passkeys'] });
  }
  async function remove(id: string) {
    const { error: err } = await authClient.passkey.deletePasskey({ id });
    if (err) { toast.danger(error(codeOf(err))); return; }
    client.invalidateQueries({ queryKey: ['passkeys'] });
  }
  return <div className="flex flex-col gap-4">
    <h3 className="font-semibold">{t('security.passkeys')}</h3>
    <p className="text-sm text-muted">{t('security.passkeysHelp')}</p>
    {!secure && <Notice tone="warning">{t('security.passkeysNeedHttps')}</Notice>}
    {!!list.data?.length && <ul ref={listRef} className="flex flex-col divide-y divide-separator rounded-lg border border-border">
      {list.data.map((p) => <li key={p.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
        <I name="fingerprint" size={16} className="text-muted"/>
        <span className="flex-1"><span className="font-medium">{p.name || t('security.passkeyUnnamed')}</span>
          {p.createdAt && <span className="block text-xs text-muted">{format.dateTime(new Date(p.createdAt), { dateStyle: 'medium' })}</span>}</span>
        <Button size="sm" variant="ghost" aria-label={`${t('security.remove')}: ${p.name || t('security.passkeyUnnamed')}`} onPress={() => remove(p.id)}><I name="trash-2" size={15}/></Button>
      </li>)}
    </ul>}
    <div className="flex flex-wrap items-start gap-2">
      <TextInput className="min-w-40 flex-1" label={t('security.passkeyName')} value={name} onChange={setName} placeholder={t('security.passkeyNamePlaceholder')}/>
      <Button className="mt-6" variant="secondary" isDisabled={!secure} isPending={busy} onPress={add}><I name="plus" size={16}/>{t('security.addPasskey')}</Button>
    </div>
  </div>;
}

function Sessions() {
  const t = useTranslations('Account');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { error } = useErrorText();
  const client = useQueryClient();
  const current = authClient.useSession().data?.session.token;
  const list = useQuery({ queryKey: ['sessions'], queryFn: async () => (await authClient.listSessions()).data ?? [] });
  async function revoke(token: string) {
    const { error: err } = await authClient.revokeSession({ token });
    if (err) { toast.danger(error(codeOf(err))); return; }
    client.invalidateQueries({ queryKey: ['sessions'] });
  }
  const device = (ua?: string | null) => !ua ? '–' : /mobile|android|iphone/i.test(ua) ? t('security.mobile') : /windows|mac os|linux/i.test(ua) ? t('security.desktop') : ua.slice(0, 40);
  return <div className="flex flex-col gap-4">
    <h3 className="font-semibold">{t('security.sessions')}</h3>
    <ul className="flex flex-col divide-y divide-separator rounded-lg border border-border">
      {(list.data ?? []).map((s) => <li key={s.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
        <I name={/mobile|android|iphone/i.test(s.userAgent ?? '') ? 'smartphone' : 'monitor'} size={16} className="text-muted"/>
        <span className="flex-1">
          <span className="font-medium">{device(s.userAgent)}</span>{s.token === current && <> <StatusChip tone="success">{t('security.thisDevice')}</StatusChip></>}
          <span className="block text-xs text-muted">{s.ipAddress ?? '–'} · {format.relativeTime(new Date(s.updatedAt ?? s.createdAt), now)}</span>
        </span>
        {s.token !== current && <Button size="sm" variant="ghost" onPress={() => revoke(s.token)}>{t('security.revoke')}</Button>}
      </li>)}
    </ul>
  </div>;
}
