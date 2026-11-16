"use client";
// A person's account and sign-in at a glance (in the user summary): profile, verified e-mail and phone, password,
// two-factor, passkeys, linked accounts and the last sign-ins - with the fixes support is asked for.
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../../components/icon';
import { ConfirmButton, StatusChip, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { authClient } from '../../../../lib/auth-client';
import { useApiQuery } from '../../../../lib/query';

type Security = { email: string; emailVerified: boolean; username: string | null; phoneNumber: string | null; phoneVerified: boolean; twoFactorEnabled: boolean; lastLoginMethod: string | null;
  authSource: string | null; locale: string | null; createdAt: string; updatedAt: string | null; password: { set: boolean; changedAt: string | null };
  accounts: { provider: string; createdAt: string }[]; passkeys: { id: string; name: string | null; deviceType: string | null; backedUp: boolean | null; createdAt: string | null }[];
  twoFactor: { failed: number; lockedUntil: string | null } | null; signIns: { action: string; outcome: string; at: string; ip: string | null }[];
  sessions: { active: number; impersonated: number; oldest: string | null } };

export function UserSecurity({ id, name, canManage, self, onSessions }: { id: string; name: string; canManage: boolean; self: boolean; onSessions?: () => void }) {
  const t = useTranslations('Users.security');
  const ta = useTranslations('Activity');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { error } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<Security>(['admin', 'user-security', id], `/admin/users/${id}/security`);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ name: string; email: string } | null>(null);
  const d = q.data;
  if (!d) return <div className="h-24 animate-pulse rounded-2xl bg-default/50"/>;

  const changed = () => { void q.refetch(); void client.invalidateQueries({ queryKey: ['admin', 'users'] }); void client.invalidateQueries({ queryKey: ['admin', 'user-summary', id] }); };
  async function call(path: string, init: { method: string; body?: unknown }, done: string) {
    setBusy(true);
    try { await apiFetch(`/admin/users/${id}${path}`, init); toast.success(done); changed(); } catch (e) { toast.danger(error(e)); throw e; } finally { setBusy(false); }
  }
  const quiet = (p: Promise<unknown>) => void p.catch(() => undefined);
  async function saveProfile() {
    if (!edit) return;
    setBusy(true);
    const r = await authClient.admin.updateUser({ userId: id, data: { name: edit.name.trim(), ...(edit.email.trim().toLowerCase() !== d!.email && { email: edit.email.trim().toLowerCase() }) } });
    setBusy(false);
    if (r.error) { toast.danger(error({ code: r.error.code ?? 'UNKNOWN' })); return; }
    toast.success(t('profileSaved')); setEdit(null); changed();
  }
  const ago = (iso?: string | null) => (iso ? format.relativeTime(new Date(Math.min(Date.parse(iso), now.getTime())), now) : '–');
  const day = (iso?: string | null) => (iso ? format.dateTime(new Date(iso), { dateStyle: 'medium' }) : '–');
  const locked = !!d.twoFactor?.lockedUntil && Date.parse(d.twoFactor.lockedUntil) > now.getTime();
  const directory = d.authSource === 'ldap';
  const action = (a: string) => (ta.has(`actions.${a.replace(/\./g, '_')}` as 'actions.settings_sms') ? ta(`actions.${a.replace(/\./g, '_')}` as 'actions.settings_sms') : a);
  const row = "flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2.5";

  return <section className="flex flex-col gap-3" aria-labelledby={`sec-${id}`}>
    <h3 id={`sec-${id}`} className="flex items-center gap-2 text-sm font-semibold"><I name="fingerprint" size={14}/>{t('title')}</h3>

    {edit ? <form className="flex flex-col gap-3 rounded-xl border border-border p-3" onSubmit={(e) => { e.preventDefault(); void saveProfile(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput label={t('name')} value={edit.name} onChange={(x) => setEdit({ ...edit, name: x })} maxLength={80}/>
        <TextInput format="email" label={t('email')} value={edit.email} onChange={(x) => setEdit({ ...edit, email: x })} help={t('emailHelp')} spellCheck={false} isDisabled={directory}/>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onPress={() => setEdit(null)}>{t('cancel')}</Button>
        <Button type="submit" size="sm" isPending={busy} isDisabled={!edit.email.trim() || (edit.name.trim() === name && edit.email.trim().toLowerCase() === d.email)}><I name="check" size={14}/>{t('save')}</Button>
      </div>
    </form> : null}

    <ul className="divide-y divide-separator rounded-xl border border-border text-sm">
      <li className={row}>
        <span className="flex min-w-0 items-center gap-2"><I name="mail" size={15} className="shrink-0 text-muted"/><span className="min-w-0 truncate">{d.email}</span>
          <StatusChip tone={d.emailVerified ? 'success' : 'warning'}>{d.emailVerified ? t('verified') : t('unverified')}</StatusChip></span>
        {canManage && <span className="flex flex-wrap gap-1.5">
          {!edit && <Button size="sm" variant="ghost" onPress={() => setEdit({ name, email: d.email })}><I name="pencil" size={13}/>{t('edit')}</Button>}
          <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => quiet(call('/email-verified', { method: 'PUT', body: { verified: !d.emailVerified } }, t(d.emailVerified ? 'markedUnverified' : 'markedVerified')))}>
            {d.emailVerified ? t('markUnverified') : t('markVerified')}</Button>
        </span>}
      </li>
      {(d.username || d.phoneNumber) && <li className={row}>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {d.username && <span className="flex items-center gap-2"><I name="at-sign" size={15} className="text-muted"/>{d.username}</span>}
          {d.phoneNumber && <span className="flex items-center gap-2"><I name="smartphone" size={15} className="text-muted"/><span className="tabular-nums">{d.phoneNumber}</span>
            <StatusChip tone={d.phoneVerified ? 'success' : 'warning'}>{d.phoneVerified ? t('verified') : t('unverified')}</StatusChip></span>}
        </span>
      </li>}
      <li className={row}>
        <span className="flex items-center gap-2"><I name="key-round" size={15} className="text-muted"/>{directory ? t('passwordDirectory') : d.password.set ? t('passwordSet', { when: ago(d.password.changedAt) }) : t('passwordNone')}</span>
        {d.lastLoginMethod && <span className="text-xs text-muted">{t('lastMethod', { method: d.lastLoginMethod })}</span>}
      </li>
      <li className={row}>
        <span className="flex flex-wrap items-center gap-2"><I name="shield-check" size={15} className="text-muted"/>{t('twoFactor')}
          <StatusChip tone={d.twoFactorEnabled ? 'success' : 'default'}>{d.twoFactorEnabled ? t('on') : t('off')}</StatusChip>
          {locked && <StatusChip tone="danger">{t('lockedUntil', { when: format.dateTime(new Date(d.twoFactor!.lockedUntil!), { timeStyle: 'short' }) })}</StatusChip>}
          {!locked && !!d.twoFactor?.failed && <span className="text-xs text-muted">{t('failedCodes', { n: d.twoFactor.failed })}</span>}</span>
        {canManage && !self && <span className="flex flex-wrap gap-1.5">
          {locked && <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => quiet(call('/two-factor/unlock', { method: 'POST' }, t('unlocked')))}><I name="lock-open" size={13}/>{t('unlock')}</Button>}
          {d.twoFactorEnabled && <ConfirmButton size="sm" variant="danger-soft" isDisabled={busy} label={t('reset2fa')} title={t('reset2faTitle')} body={t('reset2faBody')} confirmLabel={t('reset2fa')} cancelLabel={t('cancel')}
            onConfirm={() => call('/two-factor', { method: 'DELETE' }, t('reset2faDone'))}/>}
        </span>}
      </li>
      <li className={row}>
        <span className="flex items-center gap-2"><I name="monitor-smartphone" size={15} className="text-muted"/>{t('sessions', { n: d.sessions.active })}
          {d.sessions.impersonated > 0 && <StatusChip tone="warning">{t('impersonated', { n: d.sessions.impersonated })}</StatusChip>}</span>
        {onSessions && d.sessions.active > 0 && <Button size="sm" variant="ghost" onPress={onSessions}>{t('seeSessions')}<I name="arrow-right" size={13}/></Button>}
      </li>
    </ul>

    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-border p-3">
        <p className="mb-2 flex items-center gap-2 text-xs font-medium text-muted"><I name="fingerprint" size={13}/>{t('passkeys', { n: d.passkeys.length })}</p>
        {!d.passkeys.length ? <p className="text-sm text-muted">{t('noPasskeys')}</p> : <ul className="flex flex-col gap-1.5 text-sm">
          {d.passkeys.map((p) => <li key={p.id} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 flex-col"><span className="truncate">{p.name || t('passkeyUnnamed')}</span>
              <span className="text-xs text-muted">{day(p.createdAt)}{p.backedUp ? ` · ${t('synced')}` : ''}</span></span>
            {canManage && <ConfirmButton size="sm" variant="ghost" isDisabled={busy} label={<><I name="trash-2" size={13}/><span className="sr-only">{t('removePasskey')}</span></>} title={t('removePasskey')} body={t('removePasskeyBody')}
              confirmLabel={t('removePasskey')} cancelLabel={t('cancel')} onConfirm={() => call(`/passkeys/${p.id}`, { method: 'DELETE' }, t('passkeyRemoved'))}/>}
          </li>)}</ul>}
      </div>
      <div className="rounded-xl border border-border p-3">
        <p className="mb-2 flex items-center gap-2 text-xs font-medium text-muted"><I name="link" size={13}/>{t('accounts', { n: d.accounts.length })}</p>
        {!d.accounts.length ? <p className="text-sm text-muted">{t('noAccounts')}</p> : <ul className="flex flex-col gap-1.5 text-sm">
          {d.accounts.map((a) => <li key={a.provider} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 flex-col"><span className="truncate capitalize">{a.provider}</span><span className="text-xs text-muted">{t('linkedOn', { date: day(a.createdAt) })}</span></span>
            {canManage && <ConfirmButton size="sm" variant="ghost" isDisabled={busy} label={<><I name="unlink" size={13}/><span className="sr-only">{t('unlink')}</span></>} title={t('unlinkTitle', { provider: a.provider })} body={t('unlinkBody')}
              confirmLabel={t('unlink')} cancelLabel={t('cancel')} onConfirm={() => call(`/accounts/${encodeURIComponent(a.provider)}`, { method: 'DELETE' }, t('unlinked'))}/>}
          </li>)}</ul>}
      </div>
    </div>

    <div className="rounded-xl border border-border p-3">
      <p className="mb-2 flex items-center gap-2 text-xs font-medium text-muted"><I name="log-in" size={13}/>{t('signIns')}</p>
      {!d.signIns.length ? <p className="text-sm text-muted">{t('noSignIns')}</p> : <ol className="flex flex-col gap-1.5 text-sm">
        {d.signIns.map((s, i) => { const ok = s.outcome === 'success';
          return <li key={i} className="flex items-center gap-2">
            {ok ? <I name="circle-check" size={14} className="shrink-0 text-success"/> : <I name="circle-x" size={14} className="shrink-0 text-danger"/>}
            <span className="min-w-0 flex-1 truncate">{action(s.action)}</span>
            {s.ip && <span className="hidden font-mono text-xs text-muted sm:inline">{s.ip}</span>}
            <time className="shrink-0 text-xs text-muted" dateTime={s.at} title={format.dateTime(new Date(s.at), { dateStyle: 'medium', timeStyle: 'short' })}>{ago(s.at)}</time>
          </li>; })}
      </ol>}
    </div>
    <p className="text-xs text-muted">{t('memberSince', { date: day(d.createdAt) })}{d.updatedAt && <> · {t('changed', { when: ago(d.updatedAt) })}</>}</p>
  </section>;
}
