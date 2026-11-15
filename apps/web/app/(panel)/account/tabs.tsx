"use client";
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { useEffect, useState } from 'react';
import { AccessibilitySettings } from '../../../components/accessibility';
import { I } from '../../../components/icon';
import { Section, SectionMenu, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { useApiQuery } from '../../../lib/query';
import type { PublicConfig } from '../../../lib/session';
import { authClient } from '../../../lib/auth-client';
import { useMe } from '../../../lib/me';
import { SshKeys } from '../servers-ui';
import { Projects } from './account';
import NotificationPrefs from './notifications';
import Security, { SecurityScore } from './security';
import Developer from './developer';
import { MyImages } from '../server-image';
import { MyTransfers } from '../server-transfer';
import { PhoneNumber, TwoFactor } from './two-factor';
import { MyActivity } from '../../../components/activity';
import TimeZonePicker, { browserTimeZone } from '../../../components/time-zone-picker';

// Name and language; the e-mail address is the sign-in name and changes only through an administrator.
function Profile() {
  const t = useTranslations('Account');
  const { error } = useErrorText();
  const client = useQueryClient();
  const me = useMe();
  const cfg = useApiQuery<PublicConfig>(['public-config'], '/public/config').data;
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (me) { setName(me.name); setUsername(me.username ?? ''); } }, [me]);
  const withName = !!cfg?.signIn?.username;
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    const nextName = username.trim().toLowerCase();
    const r = await authClient.updateUser({ name: name.trim().slice(0, 80), ...(withName && nextName !== (me?.username ?? '') && nextName && { username: nextName }) } as Parameters<typeof authClient.updateUser>[0]);
    setBusy(false);
    if (r.error) { toast.danger(error({ code: r.error.code ?? 'UNKNOWN' })); return; }
    toast.success(t('profile.saved')); client.invalidateQueries({ queryKey: ['me'] });
  }
  return <Section title={t('profile.title')} description={t('profile.intro')}>
    <form onSubmit={save} className="grid max-w-2xl gap-4 sm:grid-cols-2" noValidate>
      <TextInput label={t('profile.name')} value={name} onChange={setName} autoComplete="name" maxLength={80}/>
      <TextInput label={t('profile.email')} value={me?.email ?? ''} onChange={() => undefined} isDisabled help={t('profile.emailHelp')}/>
      {withName && <TextInput label={t('profile.username')} value={username} onChange={(x) => setUsername(x.toLowerCase())} maxLength={30} spellCheck={false} help={t('profile.usernameHelp')}/>}
      <div className="sm:col-span-2"><Button type="submit" variant="secondary" isPending={busy}><I name="check" size={16}/>{t('profile.save')}</Button></div>
    </form>
  </Section>;
}

// Time zone for every date and time in the panel (and the statistics' days); empty: the browser's.
function Regional() {
  const t = useTranslations('Account.regional');
  const { error } = useErrorText();
  const client = useQueryClient();
  const me = useMe();
  const format = useFormatter();
  const now = useNow({ updateInterval: 1000 });
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  const zone = me.timeZone ?? browserTimeZone();
  async function pick(v: string) {
    if ((v || null) === me!.timeZone) return;
    setBusy(true);
    try { await apiFetch('/account/time-zone', { method: 'PUT', body: { timeZone: v || null } }); toast.success(t('saved')); await client.invalidateQueries({ queryKey: ['me'] }); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Section title={t('title')} description={t('intro')}>
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
      <TimeZonePicker label={t('timeZone')} value={me.timeZone ?? ''} onChange={pick} autoLabel={t('auto')} isDisabled={busy} help={t('help')}/>
      <div className="rounded-2xl border border-border bg-surface px-4 py-3 text-center">
        <p className="text-xs uppercase tracking-wider text-muted">{t('now')}</p>
        <p className="text-2xl font-semibold tabular-nums">{format.dateTime(now, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: zone })}</p>
        <p className="text-xs text-muted">{format.dateTime(now, { weekday: 'long', day: 'numeric', month: 'long', timeZone: zone })}</p>
      </div>
    </div>
  </Section>;
}

const groups = [
  ['you', ['profile', 'security', 'notifications', 'accessibility', 'activity']],
  ['servers', ['keys', 'projects', 'images', 'transfers']],
  ['developer', ['api']],
] as const;
type Tab = (typeof groups)[number][1][number];
const tabs: readonly Tab[] = groups.flatMap(([, ks]) => ks);
const tabIcons: Record<Tab, string> = { profile: 'user-round', security: 'shield-check', notifications: 'bell', accessibility: 'accessibility', activity: 'history',
  keys: 'key-round', projects: 'folder-kanban', images: 'disc-3', transfers: 'arrow-right-left', api: 'code-xml' };
export default function AccountTabs() {
  const t = useTranslations('Account');
  const [tab, setTab] = useQueryState('tab', parseAsString.withDefault('profile'));
  const current: Tab = tabs.includes(tab as Tab) ? tab as Tab : 'profile';
  const me = useMe();
  // Two-step sign-in off: the Security section is marked until it is on.
  const attention: Partial<Record<Tab, string>> = me && !me.twoFactorEnabled ? { security: t('twoFactorOff') } : {};
  return <SectionMenu label={t('title')} pickLabel={t('section')} current={current} onSelect={(k) => setTab(k)}
    groups={groups.map(([g, ks]) => ({ title: t(`groups.${g}`), items: ks.map((k) => ({ id: k, label: t(`tabs.${k}`), icon: <I name={tabIcons[k]} size={16}/>, attention: attention[k] })) }))}>
    {current === 'profile' && <><Profile/><Regional/><ExportData/></>}
    {current === 'security' && <>
      <SecurityScore/>
      <Section title={t('twoFactor.sectionTitle')} description={t('twoFactor.sectionIntro')}>
        <div className="grid gap-8 lg:grid-cols-2"><TwoFactor/><PhoneNumber/></div>
      </Section>
      <Security/>
    </>}
    {current === 'notifications' && <NotificationPrefs/>}
    {current === 'accessibility' && <Section><AccessibilitySettings/></Section>}
    {current === 'keys' && <SshKeys/>}
    {current === 'activity' && <Section title={t('activity.title')} description={t('activity.intro')}><MyActivity/></Section>}
    {current === 'projects' && <Projects/>}
    {current === 'images' && <MyImages/>}
    {current === 'transfers' && <MyTransfers/>}
    {current === 'api' && <Developer/>}
  </SectionMenu>;
}

// Everything the panel keeps about this person, as one JSON file (the API leaves secrets out).
function ExportData() {
  const t = useTranslations('Account.export');
  return <Section title={t('title')} description={t('help')}>
    <a href="/api/account/export" download className="inline-flex min-h-10 w-fit items-center gap-2 rounded-full border border-border px-4 text-sm font-medium transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">
      <I name="download" size={16}/>{t('button')}</a>
  </Section>;
}
