"use client";
// The user's notification choices: for each event, which channels (within what the admin allows).
// Also turns browser notifications on for this device and sends a test through any channel.
import { Button, Checkbox, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../components/icon';
import { Notice, Section, SwitchInput, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../../../lib/push';
import { useApiQuery } from '../../../lib/query';
import ChatConnections from './chat-connections';

export type Channel = 'inApp' | 'push' | 'email' | 'sms' | 'chat';
export const channels: Channel[] = ['inApp', 'push', 'email', 'sms', 'chat'];
type Prefs = { events: { event: string; allowed: Channel[]; locked: boolean; channels: Channel[] }[]; available: Record<Channel, boolean>; pushDevices: number; chatConnections: number; phoneVerified: boolean; quietHours: { start: string; end: string; tz: string } | null };
export const channelIcon: Record<Channel, React.ReactNode> = { inApp: <I name="bell" size={15}/>, push: <I name="monitor-smartphone" size={15}/>, email: <I name="mail" size={15}/>, sms: <I name="message-square" size={15}/>, chat: <I name="messages-square" size={15}/> };

export default function NotificationPrefs() {
  const t = useTranslations('Notify');
  const { error } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<Prefs>(['notification-prefs'], '/notifications/preferences');
  const [thisDevice, setThisDevice] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string>();
  useEffect(() => { void currentSubscription().then((s) => setThisDevice(!!s)); }, []);
  if (!q.data) return <Section title={t('title')}><p role="status" className="text-sm text-muted">…</p></Section>;
  const { events, available, phoneVerified } = q.data;

  // Why a channel cannot be used right now, if it cannot.
  const blocked = (c: Channel) => !available[c] ? t(`unavailable.${c}`) : c === 'sms' && !phoneVerified ? t('needPhone') : c === 'push' && !q.data!.pushDevices ? t('needPush') : c === 'chat' && !q.data!.chatConnections ? t('needChat') : null;

  async function toggle(event: string, current: Channel[], c: Channel, on: boolean) {
    const next = on ? [...current, c] : current.filter((x) => x !== c);
    client.setQueryData<Prefs>(['notification-prefs'], (p) => p && { ...p, events: p.events.map((e) => e.event === event ? { ...e, channels: next } : e) });
    await apiFetch('/notifications/preferences', { method: 'PUT', body: { event, channels: next } }).catch((e) => { toast.danger(error(e)); void q.refetch(); });
  }
  async function push(on: boolean) {
    setBusy('push');
    try {
      if (on) {
        const r = await enablePush();
        if (r !== 'granted') toast.warning(t(r === 'denied' ? 'pushDenied' : 'pushUnsupported'));
      } else await disablePush();
      setThisDevice(!!(await currentSubscription()));
      await q.refetch();
    } catch (e) { toast.danger(error(e)); } finally { setBusy(undefined); }
  }
  async function test(c: Channel) {
    setBusy(c);
    try { await apiFetch('/notifications/test', { method: 'POST', body: { channel: c } }); toast.success(t('testSent', { channel: t(`channel.${c}`) })); client.invalidateQueries({ queryKey: ['notifications'] }); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(undefined); }
  }

  return <div className="flex flex-col gap-6">
    <Section title={t('channelsTitle')} description={t('channelsIntro')}>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        {channels.map((c) => <li key={c} className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 font-medium"><span className="text-accent">{channelIcon[c]}</span>{t(`channel.${c}`)}</div>
          <p className="flex-1 text-xs text-muted">{blocked(c) ?? t(`channelHelp.${c}`)}</p>
          {c === 'push' && pushSupported() && <Button size="sm" variant={thisDevice ? 'secondary' : 'primary'} isPending={busy === 'push'} onPress={() => push(!thisDevice)}>
            {thisDevice ? t('pushOff') : t('pushOn')}</Button>}
          <Button size="sm" variant="ghost" isDisabled={!!blocked(c)} isPending={busy === c} onPress={() => test(c)}><I name="send" size={14}/>{t('test')}</Button>
        </li>)}
      </ul>
    </Section>

    <ChatConnections/>

    <QuietHours value={q.data.quietHours}/>

    <Section title={t('title')} description={t('intro')}>
      {events.length === 0 ? <p className="text-sm text-muted">{t('none')}</p> : <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wider text-muted">
            <th scope="col" className="py-2 pr-4 font-semibold">{t('event')}</th>
            {channels.map((c) => <th key={c} scope="col" className="px-2 py-2 text-center font-semibold"><span className="inline-flex items-center gap-1">{channelIcon[c]}<span className="hidden sm:inline">{t(`channel.${c}`)}</span></span></th>)}
          </tr></thead>
          <tbody className="divide-y divide-separator">
            {events.map((e, i) => <motion.tr key={e.event} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.025 }}>
              <th scope="row" className="py-3 pr-4 text-left font-normal">
                <span className="flex items-center gap-2 font-medium">{t(`events.${e.event.replace('.', '_')}.title` as 'events.server_ready.title')}
                  {e.locked && <I name="lock" size={13} className="text-muted" aria-label={t('locked')}/>}</span>
                <span className="text-xs text-muted">{e.locked ? t('lockedHelp') : t(`events.${e.event.replace('.', '_')}.help` as 'events.server_ready.help')}</span>
              </th>
              {channels.map((c) => <td key={c} className="px-2 py-3 text-center">
                {e.allowed.includes(c) ? <Checkbox aria-label={`${t(`channel.${c}`)}: ${e.event}`} isSelected={e.channels.includes(c)} isDisabled={e.locked}
                  onChange={(on) => toggle(e.event, e.channels, c, on)} className="inline-flex justify-center"><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control></Checkbox>
                  : <span className="text-muted" aria-label={t('notOffered')}>–</span>}
              </td>)}
            </motion.tr>)}
          </tbody>
        </table>
      </div>}
      <div className="mt-4"><Notice tone="default">{t('policyNote')}</Notice></div>
    </Section>
  </div>;
}

// Quiet hours: no browser push, SMS or messaging-app notices in a daily window (in this browser's time zone).
function QuietHours({ value }: { value: Prefs['quietHours'] }) {
  const t = useTranslations('Notify.quiet');
  const { error } = useErrorText();
  const client = useQueryClient();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [on, setOn] = useState(!!value);
  const [start, setStart] = useState(value?.start ?? '23:00');
  const [end, setEnd] = useState(value?.end ?? '08:00');
  const [busy, setBusy] = useState(false);
  async function save(next: boolean) {
    setBusy(true);
    try {
      await apiFetch('/notifications/quiet-hours', { method: 'PUT', body: { quietHours: next ? { start, end, tz: value?.tz ?? tz } : null } });
      setOn(next); toast.success(next ? t('saved', { start, end }) : t('off'));
      void client.invalidateQueries({ queryKey: ['notification-prefs'] });
    } catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Section title={t('title')} description={t('intro')}>
    <div className="flex flex-col gap-4">
      <SwitchInput label={t('enable')} isSelected={on} onChange={(x) => void save(x)} isDisabled={busy}/>
      {on && <div className="flex flex-wrap items-end gap-3">
        <TextInput className="w-36" type="time" label={t('from')} value={start} onChange={setStart}/>
        <TextInput className="w-36" type="time" label={t('to')} value={end} onChange={setEnd}/>
        <Button variant="secondary" isPending={busy} isDisabled={start === end} onPress={() => save(true)}>{t('save')}</Button>
      </div>}
      <p className="text-xs text-muted">{t('help', { tz: value?.tz ?? tz })}</p>
    </div>
  </Section>;
}
