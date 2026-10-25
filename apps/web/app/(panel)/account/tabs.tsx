"use client";
import { Button, Tabs, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { useEffect, useState } from 'react';
import { AccessibilitySettings } from '../../../components/accessibility';
import { I } from '../../../components/icon';
import { Section, TextInput } from '../../../components/ui';
import { useErrorText } from '../../../lib/api';
import { authClient } from '../../../lib/auth-client';
import { useMe } from '../../../lib/me';
import { SshKeys } from '../servers-ui';
import { Projects } from './account';
import NotificationPrefs from './notifications';
import Security from './security';
import { PhoneNumber, TwoFactor } from './two-factor';
import { MyActivity } from '../../../components/activity';

// Name and language; the e-mail address is the sign-in name and changes only through an administrator.
function Profile() {
  const t = useTranslations('Account');
  const { error } = useErrorText();
  const client = useQueryClient();
  const me = useMe();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (me) setName(me.name); }, [me]);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    const r = await authClient.updateUser({ name: name.trim().slice(0, 80) });
    setBusy(false);
    if (r.error) { toast.danger(error({ code: r.error.code ?? 'UNKNOWN' })); return; }
    toast.success(t('profile.saved')); client.invalidateQueries({ queryKey: ['me'] });
  }
  return <Section title={t('profile.title')} description={t('profile.intro')}>
    <form onSubmit={save} className="grid max-w-2xl gap-4 sm:grid-cols-2" noValidate>
      <TextInput label={t('profile.name')} value={name} onChange={setName} autoComplete="name" maxLength={80}/>
      <TextInput label={t('profile.email')} value={me?.email ?? ''} onChange={() => undefined} isDisabled help={t('profile.emailHelp')}/>
      <div className="sm:col-span-2"><Button type="submit" variant="secondary" isPending={busy}><I name="check" size={16}/>{t('profile.save')}</Button></div>
    </form>
  </Section>;
}

const tabs = ['profile', 'security', 'activity', 'notifications', 'accessibility', 'keys', 'projects'] as const;
export default function AccountTabs() {
  const t = useTranslations('Account');
  const [tab, setTab] = useQueryState('tab', parseAsString.withDefault('profile'));
  return <Tabs selectedKey={tabs.includes(tab as 'profile') ? tab : 'profile'} onSelectionChange={(k) => setTab(String(k))}>
    <Tabs.ListContainer className="overflow-x-auto">
      <Tabs.List aria-label={t('title')}>{tabs.map((k) => <Tabs.Tab key={k} id={k} className="whitespace-nowrap">{t(`tabs.${k}`)}<Tabs.Indicator/></Tabs.Tab>)}</Tabs.List>
    </Tabs.ListContainer>
    <Tabs.Panel id="profile" className="pt-5"><Profile/></Tabs.Panel>
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
  </Tabs>;
}
