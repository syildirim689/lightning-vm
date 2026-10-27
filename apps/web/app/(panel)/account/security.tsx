"use client";
import { Button, toast } from '@heroui/react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { z } from 'zod';
import { I } from '../../../components/icon';
import { CheckboxInput, Notice, Section, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { useApiQuery } from '../../../lib/query';
import SessionList, { type SessionRow } from '../../../components/session-list';
import { authClient } from '../../../lib/auth-client';
import type { PublicConfig } from '../../../lib/session';
import ProviderMark, { providerNames } from '../../../components/provider-mark';

type ClientError = { code?: string; status?: number } | null;
const codeOf = (e: ClientError) => ({ code: e?.code ?? (e?.status === 429 ? 'RATE_LIMITED' : 'UNKNOWN') });

// Password, passkeys and signed-in devices; all handled by better-auth through its client.
export default function Security() {
  const t = useTranslations('Account');
  return <Section title={t('security.title')} description={t('security.intro')}>
    <div className="grid gap-8 lg:grid-cols-2">
      <ChangePassword/>
      <Passkeys/>
    </div>
    <div className="mt-8 border-t border-separator pt-6"><Sessions/></div>
    <ConnectedAccounts/>
  </Section>;
}

// Social providers linked to this account: link one (the provider confirms it is you), or remove one while
// another way in remains. Linking happens only here, signed in: never because a provider reports this address.
function ConnectedAccounts() {
  const t = useTranslations('Account.connected');
  const { error } = useErrorText();
  const cfg = useApiQuery<PublicConfig>(['public-config'], '/public/config').data;
  const list = useQuery({ queryKey: ['accounts'], queryFn: async () => (await authClient.listAccounts()).data ?? [] });
  const client = useQueryClient();
  const providers = cfg?.signIn?.social ?? [];
  if (!providers.length) return null;
  const linked = new Map((list.data ?? []).map((a) => [a.providerId, a.accountId]));
  async function link(provider: string) {
    const { error: err } = await authClient.linkSocial({ provider, callbackURL: '/account?tab=security', errorCallbackURL: '/account?tab=security' });
    if (err) toast.danger(error(codeOf(err)));
  }
  async function unlink(providerId: string) {
    const { error: err } = await authClient.unlinkAccount({ accountId: linked.get(providerId)! });
    if (err) { toast.danger(error(codeOf(err))); return; }
    toast.success(t('removed', { name: providerNames[providerId] ?? providerId })); void client.invalidateQueries({ queryKey: ['accounts'] });
  }
  return <div className="mt-8 flex flex-col gap-3 border-t border-separator pt-6">
    <h3 className="font-semibold">{t('title')}</h3>
    <p className="text-sm text-muted">{t('intro')}</p>
    <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{providers.map((p) => <li key={p} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
      <span className="grid size-9 place-items-center rounded-lg border border-border bg-surface"><ProviderMark id={p} size={18}/></span>
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{providerNames[p] ?? p}</span>
        <span className={`text-xs ${linked.has(p) ? 'text-success' : 'text-muted'}`}>{linked.has(p) ? t('linked') : t('notLinked')}</span></span>
      {linked.has(p) ? <Button size="sm" variant="ghost" onPress={() => void unlink(p)}>{t('remove')}</Button> : <Button size="sm" variant="secondary" onPress={() => void link(p)}>{t('link')}</Button>}
    </li>)}</ul>
  </div>;
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

// The person's own sessions: each device, where from and when last active; ending the one in use signs out here.
function Sessions() {
  const t = useTranslations('Account');
  const { error } = useErrorText();
  const client = useQueryClient();
  const list = useApiQuery<{ sessions: SessionRow[] }>(['sessions'], '/account/sessions', { refetchInterval: 30_000 });
  async function end(s: SessionRow) {
    try { await apiFetch(`/account/sessions/${s.id}`, { method: 'DELETE' }); } catch (e) { toast.danger(error(e)); return; }
    if (s.current) { window.location.replace('/login'); return; }
    void client.invalidateQueries({ queryKey: ['sessions'] });
  }
  return <div className="flex flex-col gap-4">
    <h3 className="font-semibold">{t('security.sessions')}</h3>
    {list.data ? <SessionList sessions={list.data.sessions} onEnd={(s) => void end(s)}/> : <div className="h-24 animate-pulse rounded-xl bg-default/50"/>}
  </div>;
}
