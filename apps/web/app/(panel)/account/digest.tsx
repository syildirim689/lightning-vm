"use client";
// The periodic digest (GET / PUT /account/digest): one message on a chosen day and hour that says where things stand,
// instead of a notice per event. Off unless the person turns it on; customers only see the card where the
// administrator has turned the digest on for them. Where it goes is chosen like for any notification (the row
// "Periodic digest" in the list below), and "Send me a preview now" sends the digest as it would be written at this
// moment through those channels and shows its words here.
import { Button, toast } from '@heroui/react';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../components/icon';
import { Notice, Section, SelectInput, SwitchInput } from '../../../components/ui';
import { apiFetch } from '../../../lib/api';
import { useMe } from '../../../lib/me';
import { useApiAction, useApiQuery } from '../../../lib/query';

type Channel = 'inApp' | 'push' | 'email' | 'sms' | 'chat';
type State = { kind: 'staff' | 'customer'; event: string; available: boolean; enabled: boolean; frequency: 'weekly' | 'daily'; day: number; hour: number; timezone: string | null;
  nextAt: string | null; lastSentAt: string | null; channels: Channel[]; reach: Channel[] };
type Preview = { sent: boolean; empty: boolean; channels: Channel[]; title: string; body: string };

export default function DigestCard() {
  const t = useTranslations('PeriodicDigest');
  const tn = useTranslations('Notify');
  const format = useFormatter();
  const me = useMe();
  const key = ['account', 'digest'];
  const d = useApiQuery<State>(key, '/account/digest').data;
  const zone = me?.timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState<'weekly' | 'daily'>('weekly');
  const [day, setDay] = useState(1);
  const [hour, setHour] = useState(8);
  const [shown, setShown] = useState<Preview | null>(null);
  useEffect(() => { if (d) { setEnabled(d.enabled); setFrequency(d.frequency); setDay(d.day); setHour(d.hour); } }, [d]);
  const save = useApiAction(() => apiFetch<State>('/account/digest', { method: 'PUT', body: { enabled, frequency, day, hour, timezone: zone } }),
    { invalidate: [key, ['notification-prefs']], success: (r) => (r.enabled ? t('saved') : t('savedOff')) });
  const preview = useApiAction(() => apiFetch<Preview>('/account/digest/preview', { method: 'POST' }), { invalidate: [['notifications']],
    onSuccess: (r) => { setShown(r); if (r.sent) toast.success(t('previewSent', { channels: r.channels.map((c) => tn(`channel.${c}`)).join(', ') })); } });
  if (!d || !d.available) return null;
  const changed = enabled !== d.enabled || frequency !== d.frequency || day !== d.day || hour !== d.hour || (enabled && d.timezone !== zone);
  // Monday 2024-01-01 is ISO weekday 1, so day n is 2024-01-0n.
  const dayName = (n: number) => format.dateTime(new Date(2024, 0, n), { weekday: 'long' });
  return <Section title={t('title')} description={t(d.kind === 'staff' ? 'introStaff' : 'introCustomer')}>
    <div data-testid="periodic-digest" className="flex flex-col gap-4">
      <div className="grid items-end gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SwitchInput label={enabled ? t('on') : t('off')} isSelected={enabled} onChange={setEnabled}/>
        <SelectInput label={t('frequency')} value={frequency} onChange={(v) => setFrequency(v === 'daily' ? 'daily' : 'weekly')} isDisabled={!enabled}
          options={[{ id: 'weekly', label: t('weekly') }, { id: 'daily', label: t('daily') }]}/>
        {frequency === 'weekly' && <SelectInput label={t('day')} value={String(day)} onChange={(v) => setDay(Number(v) || 1)} isDisabled={!enabled}
          options={[1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: String(n), label: dayName(n) }))}/>}
        <SelectInput label={t('hour')} value={String(hour)} onChange={(v) => setHour(Number(v) || 0)} isDisabled={!enabled}
          options={Array.from({ length: 24 }, (_, h) => ({ id: String(h), label: `${String(h).padStart(2, '0')}:00` }))}/>
      </div>
      <p className="text-xs text-muted">{t('zone', { zone })} {t('rules')}</p>
      {d.enabled && d.nextAt && <p className="text-sm">{t('next', { when: format.dateTime(new Date(d.nextAt), { dateStyle: 'full', timeStyle: 'short' }) })}
        {d.lastSentAt && <span className="text-muted"> · {t('last', { when: format.dateTime(new Date(d.lastSentAt), { dateStyle: 'medium', timeStyle: 'short' }) })}</span>}</p>}
      {d.reach.length ? <p className="text-sm text-muted">{t('goesTo', { channels: d.reach.map((c) => tn(`channel.${c}`)).join(', ') })}</p>
        : <Notice tone="warning">{t('noChannel')}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" isDisabled={!changed} isPending={save.isPending} onPress={() => save.mutate()}><I name="check" size={14}/>{t('save')}</Button>
        <Button size="sm" variant="secondary" isPending={preview.isPending} onPress={() => preview.mutate()}><I name="send" size={14}/>{t('preview')}</Button>
      </div>
      {shown && <div role="status" aria-label={t('previewTitle')} className="flex flex-col gap-2 rounded-xl border border-border bg-default/40 p-4">
        <p className="text-sm font-medium">{shown.empty ? t('previewEmpty') : shown.sent ? t('previewTitle') : t('previewNotSent')}</p>
        {!shown.empty && <>
          <p className="text-sm font-semibold">{shown.title}</p>
          <pre className="max-h-80 overflow-auto font-sans text-sm leading-relaxed whitespace-pre-wrap">{shown.body}</pre>
        </>}
      </div>}
    </div>
  </Section>;
}
