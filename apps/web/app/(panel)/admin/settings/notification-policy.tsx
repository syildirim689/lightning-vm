"use client";
// The admin's rule per notification: on/off, which channels exist for it, which are on by default, and
// whether users may change their own choice. Users then choose within this on their Account page.
import { Card, Checkbox, Chip, Switch, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Notice } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';
import { channelIcon, channels, type Channel } from '../../account/notifications';

type Row = { event: string; audience: 'user' | 'staff'; permission: string | null; channels: Channel[]; enabled: boolean; allowed: Channel[]; defaults: Channel[]; userCanChange: boolean };

export default function NotificationPolicy({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Notify');
  const ts = useTranslations('Settings');
  const { error } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ events: Row[]; available: Record<Channel, boolean> }>(['settings', 'notifications'], '/admin/settings/notifications');
  if (!q.data) return <p role="status" className="text-sm text-muted">…</p>;
  const { events, available } = q.data;

  async function save(row: Row, patch: Partial<Row>) {
    const next = { ...row, ...patch };
    next.defaults = next.defaults.filter((c) => next.allowed.includes(c));
    client.setQueryData(['settings', 'notifications'], { ...q.data, events: events.map((e) => (e.event === row.event ? next : e)) });
    await apiFetch('/admin/settings/notifications', { method: 'PUT', body: { event: row.event, enabled: next.enabled, allowed: next.allowed, defaults: next.defaults, userCanChange: next.userCanChange } })
      .then(() => toast.success(ts('saved'))).catch((e) => { toast.danger(error(e)); void q.refetch(); });
  }
  const flip = (list: Channel[], c: Channel, on: boolean) => (on ? [...new Set([...list, c])] : list.filter((x) => x !== c));

  return <div className="flex flex-col gap-4">
    <Notice tone="default" title={t('policyTitle')}>{t('policyIntro')}</Notice>
    <ul className="flex flex-wrap gap-2">{channels.map((c) => <li key={c}><Chip size="sm" variant="soft" color={available[c] ? 'success' : 'default'}>
      <span className="flex items-center gap-1">{channelIcon[c]}{t(`channel.${c}`)} · {available[c] ? t('ready') : t('notConfigured')}</span></Chip></li>)}</ul>
    <div className="grid gap-3">
      {(['user', 'staff'] as const).map((aud) => <Card key={aud}>
        <Card.Header><Card.Title className="text-base font-semibold">{t(`audience.${aud}`)}</Card.Title><Card.Description className="text-xs text-muted">{t(`audienceHelp.${aud}`)}</Card.Description></Card.Header>
        <Card.Content className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wider text-muted">
              <th scope="col" className="py-2 pr-3 font-semibold">{t('event')}</th>
              <th scope="col" className="px-2 py-2 font-semibold">{t('on')}</th>
              {channels.map((c) => <th key={c} scope="col" className="px-2 py-2 text-center font-semibold"><span className="inline-flex items-center gap-1">{channelIcon[c]}{t(`channel.${c}`)}</span></th>)}
              <th scope="col" className="px-2 py-2 font-semibold">{t('userCanChange')}</th>
            </tr></thead>
            <tbody className="divide-y divide-separator">{events.filter((e) => e.audience === aud).map((e) => <tr key={e.event} className={e.enabled ? '' : 'opacity-60'}>
              <th scope="row" className="py-3 pr-3 text-left font-normal"><span className="block font-medium">{t(`events.${e.event.replace('.', '_')}.title` as 'events.server_ready.title')}</span>
                <span className="text-xs text-muted">{t(`events.${e.event.replace('.', '_')}.help` as 'events.server_ready.help')}</span></th>
              <td className="px-2 py-3"><Switch aria-label={t('on')} isSelected={e.enabled} isDisabled={readOnly} onChange={(on) => save(e, { enabled: on })}><Switch.Control><Switch.Thumb/></Switch.Control></Switch></td>
              {channels.map((c) => <td key={c} className="px-2 py-3 text-center">
                {e.channels.includes(c) ? <div className="flex flex-col items-center gap-1">
                  <Checkbox aria-label={`${t('allow')}: ${t(`channel.${c}`)}`} isSelected={e.allowed.includes(c)} isDisabled={readOnly || !e.enabled} onChange={(on) => save(e, { allowed: flip(e.allowed, c, on) })}>
                    <Checkbox.Control><Checkbox.Indicator/></Checkbox.Control></Checkbox>
                  <button type="button" disabled={readOnly || !e.enabled || !e.allowed.includes(c)} onClick={() => save(e, { defaults: flip(e.defaults, c, !e.defaults.includes(c)) })}
                    className={`rounded-full px-2 text-[10px] font-semibold uppercase ${e.defaults.includes(c) ? 'bg-accent-soft text-accent-soft-foreground' : 'text-muted'} disabled:opacity-40`}
                    aria-pressed={e.defaults.includes(c)}>{t('default')}</button>
                </div> : <span className="text-muted">–</span>}
              </td>)}
              <td className="px-2 py-3"><Switch aria-label={t('userCanChange')} isSelected={e.userCanChange} isDisabled={readOnly || !e.enabled} onChange={(on) => save(e, { userCanChange: on })}><Switch.Control><Switch.Thumb/></Switch.Control></Switch></td>
            </tr>)}</tbody>
          </table>
        </Card.Content>
      </Card>)}
    </div>
    <p className="text-xs text-muted">{t('legend')}</p>
  </div>;
}
