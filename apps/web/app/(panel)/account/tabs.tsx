"use client";
import { Button, Tabs, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { useEffect, useState } from 'react';
import { AccessibilitySettings } from '../../../components/accessibility';
import { I } from '../../../components/icon';
import { Section, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { useApiQuery } from '../../../lib/query';
import type { PublicConfig } from '../../../lib/session';
import { authClient } from '../../../lib/auth-client';
import { useMe } from '../../../lib/me';
import { SshKeys } from '../servers-ui';
import { Projects } from './account';
import NotificationPrefs from './notifications';
import Security from './security';
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

const tabs = ['profile', 'security', 'activity', 'notifications', 'accessibility', 'keys', 'projects', 'images', 'transfers', 'api'] as const;
export default function AccountTabs() {
  const t = useTranslations('Account');
  const [tab, setTab] = useQueryState('tab', parseAsString.withDefault('profile'));
  return <Tabs selectedKey={tabs.includes(tab as 'profile') ? tab : 'profile'} onSelectionChange={(k) => setTab(String(k))}>
    <Tabs.ListContainer className="overflow-x-auto">
      <Tabs.List aria-label={t('title')}>{tabs.map((k) => <Tabs.Tab key={k} id={k} className="whitespace-nowrap">{t(`tabs.${k}`)}<Tabs.Indicator/></Tabs.Tab>)}</Tabs.List>
    </Tabs.ListContainer>
    <Tabs.Panel id="profile" className="flex flex-col gap-6 pt-5"><Profile/><Regional/><ExportData/></Tabs.Panel>
    <Tabs.Panel id="security" className="flex flex-col gap-6 pt-5">
      <Section title={t('twoFactor.sectionTitle')} description={t('twoFactor.sectionIntro')}>
        <div className="grid gap-8 lg:grid-cols-2"><TwoFactor/><PhoneNumber/></div>
      </Section>
      <Security/>
    </Tabs.Panel>
    <Tabs.Panel id="notifications" className="pt-5"><NotificationPrefs/></Tabs.Panel>
    <Tabs.Panel id="accessibility" className="pt-5"><Section><AccessibilitySettings/></Section></Tabs.Panel>
    <Tabs.Panel id="keys" className="pt-5"><SshKeys/></Tabs.Panel>
    <Tabs.Panel id="activity" className="pt-5"><Section title={t('activity.title')} description={t('activity.intro')}><MyActivity/></Section></Tabs.Panel>
    <Tabs.Panel id="projects" className="pt-5"><Projects/></Tabs.Panel>
    <Tabs.Panel id="images" className="pt-5"><MyImages/></Tabs.Panel>
    <Tabs.Panel id="transfers" className="pt-5"><MyTransfers/></Tabs.Panel>
    <Tabs.Panel id="api" className="pt-5"><Developer/></Tabs.Panel>
  </Tabs>;
}

// Everything the panel keeps about this person, as one JSON file (the API leaves secrets out).
function ExportData() {
  const t = useTranslations('Account.export');
  return <Section title={t('title')} description={t('help')}>
    <a href="/api/account/export" download className="inline-flex min-h-10 w-fit items-center gap-2 rounded-full border border-border px-4 text-sm font-medium transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">
      <I name="download" size={16}/>{t('button')}</a>
  </Section>;
}
