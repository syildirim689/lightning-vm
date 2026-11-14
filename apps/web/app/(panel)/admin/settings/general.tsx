"use client";
// Settings → General: how far the panel is set up. One card per integration (ready / not set up / needs
// attention) that opens its tab, a completion bar, panel facts, and the registration switch.
import { Card } from '@heroui/react';
import { motion } from 'motion/react';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import Link from 'next/link';
import { I } from '../../../../components/icon';
import { useApiQuery } from '../../../../lib/query';
import RegistrationSetting from '../registration-setting';
import { Ago, Section, SwitchInput } from '../../../../components/ui';
import { apiFetch } from '../../../../lib/api';
import { useApiAction } from '../../../../lib/query';
import { useQueryClient } from '@tanstack/react-query';

type State = 'ok' | 'todo' | 'warn';
type Item = { key: string; tab: string | null; state: State; detail: Record<string, string | number | boolean | null> };
type Doc = { items: Item[]; registrationOpen: boolean; version: string; users: number; servers: number; startedAt: string };

const tone: Record<State, { card: string; chip: string; icon: string }> = {
  ok: { card: 'border-border', chip: 'bg-success/10 text-success', icon: 'bg-success/10 text-success' },
  todo: { card: 'border-border', chip: 'bg-default text-muted', icon: 'bg-default text-muted' },
  warn: { card: 'border-warning/60 bg-warning/5', chip: 'bg-warning/15 text-warning', icon: 'bg-warning/15 text-warning' },
};
const pretty = (id: unknown) => (typeof id !== 'string' || id === 'none' ? '' : id === 'smtp' ? 'SMTP' : id.replace(/(^|-)([a-z])/g, (_, d, c) => `${d ? ' ' : ''}${c.toUpperCase()}`));

export default function GeneralSettings({ onOpen }: { onOpen: (tab: string) => void }) {
  const t = useTranslations('Settings.general');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const q = useApiQuery<Doc>(['settings', 'overview'], '/admin/settings/overview');
  if (!q.data) return <div className="grid gap-4"><div className="h-40 animate-pulse rounded-3xl bg-default/50"/><div className="h-64 animate-pulse rounded-3xl bg-default/50"/></div>;
  const { items, version, users, servers, startedAt } = q.data;
  const ok = items.filter((i) => i.state === 'ok').length;
  const warn = items.filter((i) => i.state === 'warn');
  const pct = Math.round((ok / items.length) * 100);
  const url = items.find((i) => i.key === 'domain')?.detail.url as string | null;
  const icon = (k: string) => <I name={({ branding: 'palette', domain: 'globe-lock', security: 'shield-check', signin: 'log-in', directory: 'network', mail: 'mail', captcha: 'bot', sms: 'message-square', chat: 'messages-square',
    payments: 'credit-card', rdns: 'globe', notifications: 'bell', announcement: 'megaphone', backup: 'archive' } as Record<string, string>)[k] ?? 'settings-2'} size={18}/>;
  const detail = (i: Item) => t(`detail.${i.key}.${i.state}` as 'detail.mail.ok', { ...i.detail, provider: pretty(i.detail.provider), require2fa: t(`require2fa.${i.detail.require2fa ?? 'none'}` as 'require2fa.none') } as Record<string, string | number>);

  return <div className="flex flex-col gap-5">
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2"><Card.Content className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
        <div className="relative grid size-24 shrink-0 place-items-center self-center">
          <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden>
            <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3" className="stroke-default"/>
            <motion.circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3" strokeLinecap="round" className={warn.length ? 'stroke-warning' : 'stroke-success'}
              strokeDasharray="97.4" initial={{ strokeDashoffset: 97.4 }} animate={{ strokeDashoffset: 97.4 * (1 - pct / 100) }} transition={{ duration: 0.8, ease: 'easeOut' }}/>
          </svg>
          <span className="text-xl font-semibold tabular-nums">{pct}%</span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{t('title')}</h2>
          <p className="text-sm text-muted">{t('summary', { ok, total: items.length })}</p>
          {warn.length > 0
            ? <ul className="mt-3 flex flex-wrap gap-2">{warn.map((i) => <li key={i.key}>
                <button type="button" onClick={() => (i.tab ? onOpen(i.tab) : undefined)} className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-3 py-1 text-xs font-medium text-warning hover:bg-warning/25">
                  <I name="triangle-alert" size={13}/>{t(`name.${i.key}` as 'name.mail')}</button></li>)}</ul>
            : <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-success"><I name="circle-check" size={15}/>{t('allGood')}</p>}
        </div>
      </Card.Content></Card>

      <Card><Card.Content className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 font-semibold"><I name="info" size={16} className="text-accent"/>{t('panel')}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">{t('version')}</dt><dd className="truncate text-right font-mono text-xs leading-5">{version}</dd>
          <dt className="text-muted">{t('address')}</dt><dd className="truncate text-right">{url ? <a href={url} className="text-accent hover:underline">{url.replace(/^https?:\/\//, '')}</a> : '–'}</dd>
          <dt className="text-muted">{t('running')}</dt><dd className="text-right"><Ago at={startedAt}/></dd>
          <dt className="text-muted">{t('users')}</dt><dd className="text-right tabular-nums"><Link href="/admin/users" className="hover:underline">{users}</Link></dd>
          <dt className="text-muted">{t('servers')}</dt><dd className="text-right tabular-nums"><Link href="/admin/servers" className="hover:underline">{servers}</Link></dd>
        </dl>
      </Card.Content></Card>
    </div>

    <section aria-labelledby="general-integrations">
      <h2 id="general-integrations" className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">{t('integrations')}</h2>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {items.map((i, n) => <motion.li key={i.key} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: n * 0.03 }}>
          {(() => {
            const body = <>
              <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${tone[i.state].icon}`}>{icon(i.key)}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{t(`name.${i.key}` as 'name.mail')}</span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone[i.state].chip}`}>{t(`state.${i.state}`)}</span>
                </span>
                <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{detail(i)}</span>
              </span>
              <I name="chevron-right" size={16} className="shrink-0 self-center text-muted"/>
            </>;
            const cls = `flex h-full w-full items-start gap-3 rounded-2xl border bg-surface p-4 text-left transition-colors hover:border-accent/60 focus-visible:outline-2 focus-visible:outline-accent ${tone[i.state].card}`;
            return i.tab ? <button type="button" className={cls} onClick={() => onOpen(i.tab!)}>{body}</button> : <Link href="/admin/system" className={cls}>{body}</Link>;
          })()}
        </motion.li>)}
      </ul>
    </section>

    <div className="grid gap-4 lg:grid-cols-2"><RegistrationSetting/><StatusPageSetting/></div>
  </div>;
}

// The public status page (/status): on or off, with a link to it.
function StatusPageSetting() {
  const t = useTranslations('Settings.general.statusPage');
  const client = useQueryClient();
  const q = useApiQuery<{ enabled: boolean }>(['settings', 'status-page'], '/admin/settings/status-page');
  const save = useApiAction((enabled: boolean) => apiFetch<{ enabled: boolean }>('/admin/settings/status-page', { method: 'PUT', body: { enabled } }),
    { success: t('saved'), onSuccess: (r) => client.setQueryData(['settings', 'status-page'], r) });
  return <Section title={t('title')} description={t('help')}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <SwitchInput label={t('enabled')} isSelected={q.data?.enabled ?? false} isDisabled={!q.data || save.isPending} onChange={(v) => save.mutate(v)}/>
      {q.data?.enabled && <Link href="/status" target="_blank" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">{t('open')}<I name="external-link" size={13}/></Link>}
    </div>
  </Section>;
}
