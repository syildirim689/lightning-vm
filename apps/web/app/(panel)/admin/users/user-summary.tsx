"use client";
// A person at a glance (staff): servers and their monthly cost, sessions, recent activity, budget and role limits.
import { Button, Chip, Modal, TextArea, toast } from '@heroui/react';
import { useUnits } from '../../../../lib/units';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import NextLink from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { I } from '../../../../components/icon';
import { ConfirmButton, Stat, StatusChip } from '../../../../components/ui';
import { useApiQuery } from '../../../../lib/query';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useMe } from '../../../../lib/me';
import { can } from '../../../../lib/permissions';
import { remember } from '../../../../lib/recent';
import { UserSecurity } from './user-security';

type Summary = {
  user: { id: string; email: string; name: string; role: string; createdAt: string; twoFactorEnabled: boolean; banned: boolean; authSource: string; budgetMonthly: number | null; budgetCurrency: string | null };
  servers: { id: string; name: string; state: string; powerState: string; vcpu: number; memoryMb: number; diskGb: number; price: number; currency: string; locked: boolean }[];
  spend: { currency: string; monthly: number }[];
  sessions: { active: number; lastSeen: string | null };
  activity: { action: string; outcome: string; at: string }[];
  limits: Record<string, unknown>;
};

export function UserSummary({ id, onClose }: { id: string; onClose: () => void }) {
  const { memory } = useUnits();
  const t = useTranslations('Users.summary');
  const ta = useTranslations('Activity');
  const tr = useTranslations('Roles.limits');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const q = useApiQuery<Summary>(['admin', 'user-summary', id], `/admin/users/${id}/summary`);
  // Role names as the roles page shows them (the same cached list the users table loads).
  const roleNames = new Map((useApiQuery<{ roles: { key: string; name: string }[] }>(['admin', 'roles'], '/admin/roles').data?.roles ?? []).map((r) => [r.key, r.name]));
  const me = useMe();
  const d = q.data;
  // The palette's "recent" list: this person, under the address that finds them in the user list.
  const visited = d && (d.user.name ? `${d.user.name} (${d.user.email})` : d.user.email);
  const email = d?.user.email;
  useEffect(() => { if (visited && email) remember({ href: `/admin/users?q=${encodeURIComponent(email)}`, label: visited, kind: 'user' }); }, [visited, email]);
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
              {d.user.role.split(',').map((r) => <Chip key={r} size="sm" variant="soft">{roleNames.get(r.trim()) ?? r}</Chip>)}
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
              <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t('serverList')}</h3>
                {d.servers.length > 0 && can(me?.permissions, 'servers.view_all') && <NextLink href={`/admin/servers?owner=${encodeURIComponent(d.user.email)}`} className="text-sm text-accent hover:underline">{t('allServers')}</NextLink>}</div>
              {d.servers.length === 0 ? <p className="text-sm text-muted">{t('noServers')}</p> : <ul className="divide-y divide-separator rounded-xl border border-border">
                {d.servers.map((s) => <li key={s.id}><NextLink href={`/servers/${s.id}`} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-default/50">
                  <span aria-hidden className={`size-2 shrink-0 rounded-full ${s.state !== 'ready' ? 'bg-warning' : s.powerState === 'poweredOn' ? 'bg-success' : 'bg-default-foreground/30'}`}/>
                  <span className="min-w-0 flex-1 truncate font-medium">{s.name}{s.locked && <I name="lock" size={12} className="ml-1 inline text-warning"/>}</span>
                  <span className="hidden text-xs text-muted sm:inline">{s.vcpu} vCPU · {memory(s.memoryMb)}</span>
                  <span className="text-xs tabular-nums">{money(s.price, s.currency)}</span>
                </NextLink></li>)}
              </ul>}
            </section>
            {Object.keys(d.limits).length > 0 && <section>
              <h3 className="mb-2 text-sm font-semibold">{t('limits')}</h3>
              <div className="flex flex-wrap gap-1">{Object.entries(d.limits).map(([k, v]) => <Chip key={k} size="sm" variant="soft" color="warning">
                {k === 'require2fa' ? tr('require2faShort') : Array.isArray(v) ? tr('listShort', { name: tr(k as 'allowedIps'), n: v.length }) : `${tr(k as 'maxServers')}: ${v}`}</Chip>)}</div>
            </section>}
            <UserSecurity id={id} name={d.user.name} canManage={can(me?.permissions, 'users.manage')} self={me?.id === id}/>
            {can(me?.permissions, 'users.manage') && <ResellerAccess id={id}/>}
            <StaffNotes id={id}/>
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

type ResellerDoc = { maxCustomers: number | null; maxServers: number | null; maxVcpu: number | null; maxMemoryMb: number | null; maxDiskGb: number | null; discountPct: number; active?: boolean };
type ResellerCustomer = { id: string; email: string; name: string | null; servers: number };

// Makes this account a reseller with an allocation and a discount (empty: no limit), or stops it.
function ResellerAccess({ id }: { id: string }) {
  const t = useTranslations('Reseller.admin');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ reseller: ResellerDoc | null; usage?: { servers: number; vcpu: number; memoryMb: number; diskGb: number }; customers?: ResellerCustomer[] }>(['admin', 'reseller', id], `/admin/resellers/${id}`);
  const [v, setV] = useState<Record<string, string> | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (!q.data) return null;
  const r = q.data.reseller;
  const doc = v ?? Object.fromEntries((['maxCustomers', 'maxServers', 'maxVcpu', 'maxMemoryMb', 'maxDiskGb', 'discountPct'] as const).map((k) => [k, r?.[k] == null ? '' : String(k === 'maxMemoryMb' ? (r[k] as number) / 1024 : r[k])]));
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...doc, [k]: e.target.value.replace(/[^\d.]/g, '') });
  async function save(active = true) {
    setBusy(true); setFields({});
    try {
      await apiFetch(`/admin/resellers/${id}`, { method: 'PUT', body: { ...doc, maxMemoryMb: doc.maxMemoryMb === '' ? null : Math.round(Number(doc.maxMemoryMb) * 1024), active } });
      toast.success(t('saved')); setV(null); void client.invalidateQueries({ queryKey: ['admin', 'reseller', id] });
    } catch (e) { setFields((e as { fields?: Record<string, string> }).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true);
    try { await apiFetch(`/admin/resellers/${id}`, { method: 'DELETE' }); toast.success(t('stopped')); setV(null); void client.invalidateQueries({ queryKey: ['admin', 'reseller', id] }); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  // One customer out of the reseller's hands (the same as the customer leaving): the result says what moved.
  async function release(c: ResellerCustomer) {
    try {
      const out = await apiFetch<{ servers: number; subscriptions: number; withdrawnInvoices?: string[]; leftInvoices?: string[] }>(`/admin/resellers/${id}/customers/${c.id}`, { method: 'DELETE' });
      toast.success(t('released', { email: c.email, servers: out.servers ?? 0, subscriptions: out.subscriptions ?? 0, withdrawn: out.withdrawnInvoices?.length ?? 0, left: out.leftInvoices?.length ?? 0 }));
    } catch (e) {
      toast.danger(error(e));
      // No longer this reseller's customer (they left meanwhile): the list is read again; otherwise the question stays.
      if ((e as { code?: string })?.code !== 'NOT_FOUND') throw e;
    }
    for (const queryKey of [['admin', 'reseller', id], ['admin', 'users'], ['admin', 'billing']]) void client.invalidateQueries({ queryKey });
  }
  const input = (k: string, label: string) => <label className="flex flex-col gap-1 text-xs"><span className="text-muted">{label}</span>
    <input inputMode="decimal" value={doc[k]} onChange={set(k)} placeholder={t('noLimit')} className="min-h-10 rounded-lg border border-border bg-surface px-2 text-sm"/>
    {fields[k] && <span className="text-danger">{field(fields[k])}</span>}</label>;
  return <section className="rounded-xl border border-border p-3">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t('title')}</h3>
      {r && <StatusChip tone={r.active ? 'success' : 'default'}>{r.active ? t('active') : t('paused')}</StatusChip>}</div>
    <p className="mb-3 text-xs text-muted">{t('help')}</p>
    {fields.userId && <p className="mb-2 text-sm text-danger">{field(fields.userId)}</p>}
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {input('maxCustomers', t('customers'))}{input('maxServers', t('servers'))}{input('maxVcpu', 'vCPU')}
      {input('maxMemoryMb', t('memory'))}{input('maxDiskGb', t('disk'))}{input('discountPct', t('discount'))}
    </div>
    {r && q.data.usage && <p className="mt-2 text-xs text-muted">{t('using', { servers: q.data.usage.servers, vcpu: q.data.usage.vcpu, memory: Math.round(q.data.usage.memoryMb / 1024), disk: q.data.usage.diskGb })}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <Button size="sm" isPending={busy} onPress={() => void save(true)}><I name="store" size={14}/>{r ? t('save') : t('make')}</Button>
      {r?.active && <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void save(false)}>{t('pause')}</Button>}
      {r && <ConfirmButton size="sm" variant="danger-soft" isDisabled={busy} label={t('stop')} title={t('stopTitle')} body={t('stopBody')} confirmLabel={t('stop')} cancelLabel={t('cancel')} onConfirm={stop}/>}
    </div>
    {r && q.data.customers && <div className="mt-3 border-t border-separator pt-3">
      <h4 className="mb-2 text-xs font-semibold">{t('customersTitle', { n: q.data.customers.length })}</h4>
      {q.data.customers.length === 0 ? <p className="text-xs text-muted">{t('noCustomers')}</p> : <ul className="divide-y divide-separator rounded-lg border border-border">
        {q.data.customers.map((c) => <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
          <span className="min-w-0 flex-1"><span className="block truncate">{c.email}</span>
            <span className="block truncate text-xs text-muted">{[c.name, t('customerServers', { n: c.servers })].filter(Boolean).join(' · ')}</span></span>
          <ConfirmButton size="sm" variant="ghost" isDisabled={busy} icon={<I name="user-minus" size={14}/>} label={<span className="whitespace-nowrap">{t('release')}<span className="sr-only"> {c.email}</span></span>}
            title={t('releaseTitle', { email: c.email })} body={t('releaseBody')} confirmLabel={t('release')} cancelLabel={t('cancel')} onConfirm={() => release(c)}/>
        </li>)}
      </ul>}
    </div>}
  </section>;
}

type Note = { id: string; body: string; pinned: boolean; createdAt: string; authorId: string | null; authorName: string | null; authorEmail: string | null };

// Notes staff keep on a person (a call, an agreement, a warning); pinned ones also show in the users list.
function StaffNotes({ id }: { id: string }) {
  const t = useTranslations('Users.notes');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { error } = useErrorText();
  const client = useQueryClient();
  const write = can(useMe()?.permissions, 'users.manage');
  const q = useApiQuery<{ notes: Note[] }>(['admin', 'user-notes', id], `/admin/users/${id}/notes`);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const changed = () => { void q.refetch(); void client.invalidateQueries({ queryKey: ['admin', 'users'] }); };
  async function call(path: string, init: { method: string; body?: unknown }, done?: string) {
    setBusy(true);
    try { await apiFetch(path, init); if (done) toast.success(done); changed(); return true; } catch (e) { toast.danger(error(e)); return false; } finally { setBusy(false); }
  }
  async function add() { if (await call(`/admin/users/${id}/notes`, { method: 'POST', body: { body: text } }, t('added'))) setText(''); }
  const notes = q.data?.notes;
  return <section>
    <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><I name="sticky-note" size={14}/>{t('title')}<span className="text-xs font-normal text-muted">{t('private')}</span></h3>
    {write && <div className="mb-3 flex flex-col gap-2">
      <TextArea aria-label={t('placeholder')} placeholder={t('placeholder')} value={text} maxLength={2000} rows={2} autoComplete="off"
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) { e.preventDefault(); void add(); } }}/>
      <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted">{text.length > 1800 ? `${text.length}/2000` : t('hint')}</span>
        <Button size="sm" isDisabled={!text.trim()} isPending={busy} onPress={() => void add()}><I name="plus" size={14}/>{t('add')}</Button></div>
    </div>}
    {!notes ? <div className="h-12 animate-pulse rounded-xl bg-default/50"/> : notes.length === 0 ? <p className="text-sm text-muted">{t('empty')}</p> : <ul className="flex flex-col gap-2">
      {notes.map((n) => <li key={n.id} className={`rounded-xl border px-3 py-2 text-sm ${n.pinned ? 'border-warning/40 bg-warning/5' : 'border-border'}`}>
        <p className="whitespace-pre-wrap break-words">{n.body}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          {n.pinned && <span className="inline-flex items-center gap-1 text-warning"><I name="pin" size={11}/>{t('pinned')}</span>}
          <span>{n.authorName || n.authorEmail || t('removedAuthor')}</span>
          <time dateTime={n.createdAt} title={format.dateTime(new Date(n.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}>{format.relativeTime(new Date(Math.min(Date.parse(n.createdAt), now.getTime())), now)}</time>
          {write && <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" isIconOnly aria-label={n.pinned ? t('unpin') : t('pin')} isDisabled={busy}
              onPress={() => void call(`/admin/users/${id}/notes/${n.id}`, { method: 'PATCH', body: { pinned: !n.pinned } })}><I name={n.pinned ? 'pin-off' : 'pin'} size={13}/></Button>
            <ConfirmButton size="sm" variant="ghost" isDisabled={busy} label={<><I name="trash-2" size={13}/><span className="sr-only">{t('remove')}</span></>}
              title={t('removeTitle')} body={<span className="line-clamp-3 whitespace-pre-line">{n.body}</span>} confirmLabel={t('remove')} cancelLabel={t('cancel')}
              onConfirm={() => call(`/admin/users/${id}/notes/${n.id}`, { method: 'DELETE' }, t('removed')).then(() => undefined)}/>
          </span>}
        </div>
      </li>)}
    </ul>}
  </section>;
}
