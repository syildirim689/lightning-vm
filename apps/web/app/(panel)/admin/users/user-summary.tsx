"use client";
// A person at a glance (staff): servers and their monthly cost, sessions, recent activity, budget and role limits.
import { Chip, Modal } from '@heroui/react';
import NextLink from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { I } from '../../../../components/icon';
import { Stat, StatusChip } from '../../../../components/ui';
import { useApiQuery } from '../../../../lib/query';

type Summary = {
  user: { id: string; email: string; name: string; role: string; createdAt: string; twoFactorEnabled: boolean; banned: boolean; authSource: string; budgetMonthly: number | null; budgetCurrency: string | null };
  servers: { id: string; name: string; state: string; powerState: string; vcpu: number; memoryMb: number; diskGb: number; price: number; currency: string; locked: boolean }[];
  spend: { currency: string; monthly: number }[];
  sessions: { active: number; lastSeen: string | null };
  activity: { action: string; outcome: string; at: string }[];
  limits: Record<string, unknown>;
};

export function UserSummary({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations('Users.summary');
  const ta = useTranslations('Activity');
  const tr = useTranslations('Roles.limits');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const q = useApiQuery<Summary>(['admin', 'user-summary', id], `/admin/users/${id}/summary`);
  const d = q.data;
  const money = (n: number, c: string) => format.number(n, { style: 'currency', currency: c });
  const action = (a: string) => (ta.has(`actions.${a.replace(/\./g, '_')}` as 'actions.settings_sms') ? ta(`actions.${a.replace(/\./g, '_')}` as 'actions.settings_sms') : a);
  return <Modal.Backdrop isOpen onOpenChange={(o) => { if (!o) onClose(); }}>
    <Modal.Container size="lg" scroll="inside">
      <Modal.Dialog className="bg-surface">
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading className="flex flex-col">
          <span>{d ? d.user.name || d.user.email : '…'}</span>
          {d && <span className="text-sm font-normal text-muted">{d.user.email}</span>}
        </Modal.Heading></Modal.Header>
        <Modal.Body className="flex flex-col gap-5">
          {!d ? <div className="h-40 animate-pulse rounded-2xl bg-default/50"/> : <>
            <div className="flex flex-wrap gap-2">
              {d.user.role.split(',').map((r) => <Chip key={r} size="sm" variant="soft">{r}</Chip>)}
              <StatusChip tone={d.user.twoFactorEnabled ? 'success' : 'warning'}>{d.user.twoFactorEnabled ? '2FA' : t('no2fa')}</StatusChip>
              {d.user.authSource === 'ldap' && <StatusChip tone="accent">{t('directory')}</StatusChip>}
              {d.user.banned && <StatusChip tone="danger">{t('banned')}</StatusChip>}
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t('servers')} value={d.servers.length} icon={<I name="server" size={16}/>}/>
              <Stat label={t('monthly')} value={d.spend.length ? d.spend.map((s) => money(s.monthly, s.currency)).join(' + ') : '–'} icon={<I name="wallet" size={16}/>} tone="accent"/>
              <Stat label={t('sessions')} value={d.sessions.active} hint={d.sessions.lastSeen ? t('lastSeen', { when: format.relativeTime(new Date(d.sessions.lastSeen), now) }) : undefined} icon={<I name="monitor-smartphone" size={16}/>}/>
              <Stat label={t('member')} value={format.dateTime(new Date(d.user.createdAt), { dateStyle: 'medium' })} icon={<I name="calendar" size={16}/>}/>
            </div>
            {d.user.budgetMonthly && <p className="text-sm text-muted"><I name="wallet" size={14} className="mr-1 inline"/>{t('budget', { amount: money(d.user.budgetMonthly, d.user.budgetCurrency ?? 'EUR') })}</p>}
            <section>
              <h3 className="mb-2 text-sm font-semibold">{t('serverList')}</h3>
              {d.servers.length === 0 ? <p className="text-sm text-muted">{t('noServers')}</p> : <ul className="divide-y divide-separator rounded-xl border border-border">
                {d.servers.map((s) => <li key={s.id}><NextLink href={`/servers/${s.id}`} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-default/50">
                  <span aria-hidden className={`size-2 shrink-0 rounded-full ${s.state !== 'ready' ? 'bg-warning' : s.powerState === 'poweredOn' ? 'bg-success' : 'bg-default-foreground/30'}`}/>
                  <span className="min-w-0 flex-1 truncate font-medium">{s.name}{s.locked && <I name="lock" size={12} className="ml-1 inline text-warning"/>}</span>
                  <span className="hidden text-xs text-muted sm:inline">{s.vcpu} vCPU · {s.memoryMb / 1024} GB</span>
                  <span className="text-xs tabular-nums">{money(s.price, s.currency)}</span>
                </NextLink></li>)}
              </ul>}
            </section>
            {Object.keys(d.limits).length > 0 && <section>
              <h3 className="mb-2 text-sm font-semibold">{t('limits')}</h3>
              <div className="flex flex-wrap gap-1">{Object.entries(d.limits).map(([k, v]) => <Chip key={k} size="sm" variant="soft" color="warning">
                {k === 'require2fa' ? tr('require2faShort') : Array.isArray(v) ? tr('listShort', { name: tr(k as 'allowedIps'), n: v.length }) : `${tr(k as 'maxServers')}: ${v}`}</Chip>)}</div>
            </section>}
            <section>
              <h3 className="mb-2 text-sm font-semibold">{t('activity')}</h3>
              {d.activity.length === 0 ? <p className="text-sm text-muted">{t('noActivity')}</p> : <ol className="flex flex-col gap-1.5">
                {d.activity.map((a, i) => <li key={i} className="flex items-center gap-2 text-sm">
                  <I name={({ success: 'circle-check', denied: 'ban', failure: 'circle-x' } as Record<string, string>)[a.outcome] ?? 'circle-x'} size={14} className={a.outcome === 'success' ? 'text-success' : 'text-danger'}/>
                  <span className="min-w-0 flex-1 truncate">{action(a.action)}</span>
                  <time className="shrink-0 text-xs text-muted" dateTime={a.at}>{format.relativeTime(new Date(a.at), now)}</time>
                </li>)}
              </ol>}
              <NextLink href={`/admin/audit?q=${encodeURIComponent(d.user.email)}`} className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline">{t('allActivity')}<I name="arrow-right" size={12}/></NextLink>
            </section>
          </>}
        </Modal.Body>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}
