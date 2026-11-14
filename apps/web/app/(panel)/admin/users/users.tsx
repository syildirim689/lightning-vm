"use client";
// User management: better-auth's admin API (create, ban, password, sessions, impersonation, removal) and
// the panel's access API (roles + per-user permission overrides). Buttons appear only with the permission.
import { Avatar, Button, Chip, Dropdown, Label, Modal, SearchField, toast } from '@heroui/react';
import { writeDraft } from '../../../../lib/drafts';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { useEffect, useMemo, useRef, useState } from 'react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { I } from '../../../../components/icon';
import { UserSummary } from './user-summary';
import SessionList, { LastSeen, PresenceDot, type Presence, type SessionRow } from '../../../../components/session-list';
import { CheckboxList, ConfirmButton, ConfirmDialog, DataTable, Notice, PageHeader, SelectInput, StatusChip, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { authClient } from '../../../../lib/auth-client';
import { useMe } from '../../../../lib/me';
import { can } from '../../../../lib/permissions';
import { useApiQuery } from '../../../../lib/query';
import { fold } from '../../../../lib/note-line';
import { downloadCsv } from '../../../../lib/csv';
import { strongPassword } from '../../../../lib/password';

type Row = { id: string; email: string; name: string; role: string; locale: string; createdAt: string; banned: boolean; banReason: string | null; banExpires: string | null;
  twoFactorEnabled: boolean; authSource?: string; lastLoginMethod: string | null; phoneNumber: string | null; servers: number; sessions: number; lastSeen: string | null; overrides: number; presence: Presence; notes: number; pinnedNote: string | null };
type Role = { key: string; name: string; description: string; permissions: string[]; builtin: boolean; members: number };
type Override = { permission: string; effect: 'allow' | 'deny' };
type ClientError = { code?: string; status?: number } | null;
const codeOf = (e: ClientError) => ({ code: e?.code ?? (e?.status === 429 ? 'RATE_LIMITED' : 'UNKNOWN') });

// A generated password the admin can see, replace and copy (it goes to the user by another channel).
function PasswordInput({ label, value, onChange, help, error }: { label: string; value: string; onChange: (v: string) => void; help: string; error?: string }) {
  const t = useTranslations('Users');
  return <div className="flex flex-col gap-2">
    <TextInput label={label} value={value} onChange={onChange} help={help} error={error} spellCheck={false}/>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onPress={() => onChange(strongPassword())}><I name="wand-sparkles" size={15}/>{t('form.generate')}</Button>
      <Button size="sm" variant="ghost" isDisabled={!value} onPress={async () => { await navigator.clipboard?.writeText(value).then(() => toast.success(t('form.passwordCopied')), () => undefined); }}>
        <I name="copy" size={15}/>{t('form.copy')}</Button>
    </div>
  </div>;
}

export default function Users() {
  const t = useTranslations('Users');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const me = useMe();
  const perms = me?.permissions;
  const users = useApiQuery<{ users: Row[] }>(['admin', 'users'], '/admin/users').data?.users;
  const roles = useApiQuery<{ roles: Role[] }>(['admin', 'roles'], '/admin/roles').data?.roles ?? [];
  const [search, setSearch] = useQueryState('q', parseAsString.withDefault(''));
  const [role, setRole] = useQueryState('role', parseAsString.withDefault(''));
  const [status, setStatus] = useQueryState('status', parseAsString.withDefault(''));
  const [summaryOf, setSummaryOf] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'create' | 'access' | 'ban' | 'password' | 'sessions' | 'remove' | 'bulk'; user?: Row }>();
  const tr = useTranslations('Roles');
  const roleName = (k: string) => (tr.has(`builtinName.${k}` as 'builtinName.admin') ? tr(`builtinName.${k}` as 'builtinName.admin') : roles.find((r) => r.key === k)?.name ?? k);

  const rows = useMemo(() => (users ?? []).filter((u) => {
    const q = fold(search.trim());
    if (q && !fold(`${u.email} ${u.name} ${u.phoneNumber ?? ''} ${u.pinnedNote ?? ''}`).includes(q)) return false;
    if (role && !u.role.split(',').includes(role)) return false;
    if (status === 'banned' && !u.banned) return false;
    if (status === 'online' && u.presence === 'offline') return false;
    if (status === 'active' && u.banned) return false;
    if (status === 'no2fa' && u.twoFactorEnabled) return false;
    // Dormant: not around and not seen for 30 days (or never); new: signed up in the last 7 days.
    if (status === 'inactive' && (u.presence !== 'offline' || (u.lastSeen && now.getTime() - Date.parse(u.lastSeen) < 30 * 86_400_000))) return false;
    if (status === 'new' && now.getTime() - Date.parse(u.createdAt) > 7 * 86_400_000) return false;
    return true;
  // Online first, then the most recently seen, when looking at who is around.
  }).sort((a, b) => status !== 'online' ? 0 : Number(b.presence === 'online') - Number(a.presence === 'online') || Date.parse(b.lastSeen ?? '0') - Date.parse(a.lastSeen ?? '0')), [users, search, role, status, now]);

  const stats = users && { total: users.length, banned: users.filter((u) => u.banned).length, twoFactor: users.filter((u) => u.twoFactorEnabled).length,
    staff: users.filter((u) => u.role.split(',').some((r) => r !== 'user')).length, online: users.filter((u) => u.presence !== 'offline').length };

  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')}
      actions={can(perms, 'users.manage') && <Button onPress={() => setDialog({ kind: 'create' })}><I name="user-plus" size={16}/>{t('new')}</Button>}/>
    {stats && <ul className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
      {([['total', 'users'], ['online', 'radio'], ['staff', 'shield-check'], ['twoFactor', 'lock'], ['banned', 'ban']] as const).map(([k, icon]) => <li key={k} className={`flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 ${k === 'online' || k === 'banned' ? 'cursor-pointer hover:border-accent/50' : ''} ${status === k ? 'border-accent bg-accent-soft/40 ring-1 ring-accent' : ''}`} {...((k === 'online' || k === 'banned') && { role: 'button', tabIndex: 0, 'aria-pressed': status === k, onClick: () => void setStatus(status === k ? null : k), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void setStatus(status === k ? null : k); } } })}>
        <span className="grid size-9 place-items-center rounded-lg bg-default text-muted">{icon === 'users' ? <I name="users" size={16}/> : icon === 'shield-check' ? <I name="shield-check" size={16}/> : icon === 'lock' ? <I name="lock" size={16}/> : icon === 'radio' ? <span className="text-success"><I name="radio" size={16}/></span> : <I name="ban" size={16}/>}</span>
        <span><span className="block text-lg font-semibold tabular-nums">{stats[k]}</span><span className="text-xs text-muted">{t(`stat.${k}`)}</span></span>
      </li>)}
    </ul>}
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <SearchField aria-label={t('search')} value={search} onChange={(v) => void setSearch(v || null)} className="min-w-64 flex-1">
        <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('search')}/><SearchField.ClearButton/></SearchField.Group>
      </SearchField>
      <SelectInput className="w-44" label={t('filterRole')} value={role} onChange={(v) => void setRole(v || null)} options={[{ id: '', label: t('all') }, ...roles.map((r) => ({ id: r.key, label: roleName(r.key) }))]}/>
      <SelectInput className="w-52" label={t('filterStatus')} value={status} onChange={(v) => void setStatus(v || null)}
        options={[{ id: '', label: t('all') }, { id: 'active', label: t('active') }, { id: 'banned', label: t('banned') }, { id: 'no2fa', label: t('no2fa') }, { id: 'online', label: t('onlineFilter') },
          { id: 'inactive', label: t('inactiveFilter') }, { id: 'new', label: t('newFilter') }]}/>
      <span className="flex gap-2">
        {(can(perms, 'users.manage') || can(perms, 'users.sessions')) && <Button variant="secondary" isDisabled={!rows.some((u) => u.id !== me?.id)} onPress={() => setDialog({ kind: 'bulk' })}><I name="users" size={16}/>{t('bulk.open', { n: Math.min(rows.filter((u) => u.id !== me?.id).length, 200) })}</Button>}
        <Button variant="ghost" isDisabled={!rows.length} onPress={() => downloadCsv('users', ['email', 'name', 'roles', 'status', 'two_factor', 'sign_in', 'servers', 'sessions', 'last_seen', 'created_at', 'pinned_note'],
          rows.map((u) => [u.email, u.name, u.role, u.banned ? 'banned' : 'active', u.twoFactorEnabled, u.authSource ?? '', u.servers, u.sessions, u.lastSeen ?? '', u.createdAt, u.pinnedNote ?? '']))}><I name="download" size={16}/>{t('exportCsv')}</Button>
      </span>
    </div>
    <DataTable label={t('title')} rows={rows} rowKey={(u) => u.id} empty={users ? t('empty') : '…'} minWidth={900}
      sortBy={{ user: (u) => u.name || u.email, status: (u) => (u.banned ? 1 : 0), servers: (u) => u.servers, seen: (u) => (u.presence === 'online' ? Date.now() : u.lastSeen ? Date.parse(u.lastSeen) : null) }}
      columns={[{ id: 'user', label: t('col.user') }, { id: 'roles', label: t('col.roles') }, { id: 'status', label: t('col.status') }, { id: 'security', label: t('col.security') },
        { id: 'servers', label: t('col.servers') }, { id: 'seen', label: t('col.lastSeen') }, { id: 'act', label: <span className="sr-only">{t('col.actions')}</span> }]}
      cells={(u) => [
        <span key="u" className="flex min-w-0 items-center gap-3">
          <span className="relative shrink-0"><Avatar size="sm"><Avatar.Fallback>{(u.name || u.email).slice(0, 2).toUpperCase()}</Avatar.Fallback></Avatar>
            <PresenceDot presence={u.presence} className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-surface"/></span>
          <button type="button" data-row-open onClick={() => setSummaryOf(u.id)} className="min-w-0 rounded text-left hover:underline focus-visible:outline-2 focus-visible:outline-accent"><span className="block truncate font-medium">{u.name || u.email}</span>{u.name && <span className="block truncate text-xs text-muted">{u.email}</span>}
            {u.pinnedNote && <span className="mt-0.5 flex max-w-64 items-center gap-1 truncate text-xs text-warning" title={u.pinnedNote}><I name="pin" size={11} className="shrink-0"/><span className="truncate">{u.pinnedNote}</span></span>}</button>
          {u.notes > 0 && !u.pinnedNote && <span className="shrink-0 text-muted" title={t('notesCount', { n: u.notes })}><I name="sticky-note" size={13}/></span>}
        </span>,
        <span key="r" className="flex flex-wrap gap-1">{u.role.split(',').map((r) => <Chip key={r} size="sm" variant={r === 'user' ? 'secondary' : 'soft'} color={r === 'admin' ? 'accent' : 'default'}>{roleName(r)}</Chip>)}
          {u.overrides > 0 && <Chip size="sm" variant="soft" color="warning">{t('overrides', { n: u.overrides })}</Chip>}</span>,
        u.banned ? <span key="s" className="flex flex-col"><StatusChip tone="danger">{t('banned')}</StatusChip>
          <span className="mt-0.5 text-xs text-muted">{[u.banReason, u.banExpires && t('until', { date: format.dateTime(new Date(u.banExpires), { dateStyle: 'medium', timeStyle: 'short' }) })].filter(Boolean).join(' · ')}</span></span>
          : <StatusChip key="s" tone="success">{t('active')}</StatusChip>,
        <span key="sec" className="flex flex-wrap items-center gap-1">
          <StatusChip tone={u.twoFactorEnabled ? 'success' : 'default'}>{u.twoFactorEnabled ? '2FA' : t('no2faShort')}</StatusChip>
          {u.authSource === 'ldap' && <StatusChip tone="accent">{t('directory')}</StatusChip>}
          {u.lastLoginMethod && <span className="text-xs text-muted">{t(`method.${u.lastLoginMethod === 'passkey' ? 'passkey' : 'email'}`)}</span>}
        </span>,
        u.servers > 0 && can(perms, 'servers.view_all')
          ? <NextLink key="srv" href={`/admin/servers?owner=${encodeURIComponent(u.email)}`} aria-label={t('serversOf', { n: u.servers, email: u.email })} className="tabular-nums text-accent hover:underline">{u.servers}</NextLink>
          : <span key="srv" className="tabular-nums">{u.servers}</span>,
        <span key="seen" className="flex flex-col text-xs"><LastSeen presence={u.presence} at={u.lastSeen}/>{u.sessions > 0 && <span className="text-muted">{t('sessionCount', { n: u.sessions })}</span>}</span>,
        <RowActions key="a" user={u} self={u.id === me?.id} perms={perms} open={(kind) => setDialog({ kind, user: u })}/>,
      ]}/>
    {dialog?.kind === 'create' && <CreateUser roles={roles} onClose={() => setDialog(undefined)}/>}
    {dialog?.kind === 'access' && dialog.user && <AccessEditor user={dialog.user} roles={roles} onClose={() => setDialog(undefined)}/>}
    {dialog?.kind === 'ban' && dialog.user && <BanUser user={dialog.user} onClose={() => setDialog(undefined)}/>}
    {dialog?.kind === 'password' && dialog.user && <SetPassword user={dialog.user} onClose={() => setDialog(undefined)}/>}
    {dialog?.kind === 'sessions' && dialog.user && <UserSessions user={dialog.user} canRevoke={can(perms, 'users.sessions')} onClose={() => setDialog(undefined)}/>}
    {dialog?.kind === 'remove' && dialog.user && <RemoveUser user={dialog.user} onClose={() => setDialog(undefined)}/>}
    {dialog?.kind === 'bulk' && <BulkAction people={rows.filter((u) => u.id !== me?.id).slice(0, 200)} perms={perms} onClose={() => setDialog(undefined)}/>}
    {summaryOf && <UserSummary id={summaryOf} onClose={() => setSummaryOf(null)}/>}
  </>;
}

function RowActions({ user, self, perms, open }: { user: Row; self: boolean; perms?: string[]; open: (k: 'access' | 'ban' | 'password' | 'sessions' | 'remove') => void }) {
  const t = useTranslations('Users');
  const { error } = useErrorText();
  const router = useRouter();
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  // Signing in as someone is recorded and changes whose panel this tab shows, so it is asked first.
  async function impersonate() {
    const r = await authClient.admin.impersonateUser({ userId: user.id });
    if (r.error) { toast.danger(error(codeOf(r.error))); return; }
    setAsking(false); router.replace('/'); router.refresh();
  }
  async function act(k: string) {
    if (k === 'impersonate') { setAsking(true); return; }
    if (k === 'unban') {
      const r = await authClient.admin.unbanUser({ userId: user.id });
      if (r.error) { toast.danger(error(codeOf(r.error))); return; }
      toast.success(t('unbanned')); client.invalidateQueries({ queryKey: ['admin', 'users'] }); return;
    }
    open(k as 'access');
  }
  const items: [string, string, React.ReactNode, boolean][] = [
    ['access', t('action.access'), <I key="i" name="shield-check" size={16}/>, can(perms, 'users.roles') && !self],
    ['sessions', t('action.sessions'), <I key="i" name="monitor" size={16}/>, can(perms, 'users.view')],
    ['password', t('action.password'), <I key="i" name="key-round" size={16}/>, can(perms, 'users.manage') && !self],
    ['impersonate', t('action.impersonate'), <I key="i" name="user-round-cog" size={16}/>, can(perms, 'users.impersonate') && !self && !user.banned],
    [user.banned ? 'unban' : 'ban', user.banned ? t('action.unban') : t('action.ban'), <I key="i" name="ban" size={16}/>, can(perms, 'users.ban') && !self],
    ['remove', t('action.remove'), <I key="i" name="trash-2" size={16}/>, can(perms, 'users.manage') && !self],
  ];
  const visible = items.filter((i) => i[3]);
  if (!visible.length) return null;
  return <><ConfirmDialog isOpen={asking} onClose={() => setAsking(false)} status="warning" title={t('impersonateTitle', { email: user.email })}
    body={t('impersonateBody')} confirmLabel={t('action.impersonate')} cancelLabel={t('cancel')} onConfirm={impersonate}/>
  <Dropdown>
    <Button isIconOnly size="sm" variant="ghost" aria-label={t('actionsFor', { email: user.email })}><I name="ellipsis" size={18}/></Button>
    <Dropdown.Popover placement="bottom end">
      <Dropdown.Menu aria-label={t('actionsFor', { email: user.email })} onAction={(k) => void act(String(k))}>
        {visible.map(([id, label, icon]) => <Dropdown.Item key={id} id={id} textValue={label} variant={id === 'remove' || id === 'ban' ? 'danger' : 'default'}>{icon}<Label>{label}</Label></Dropdown.Item>)}
      </Dropdown.Menu>
    </Dropdown.Popover>
  </Dropdown></>;
}

// One dialog shell for every user action: title, body, footer with the action.
function Dialog({ title, onClose, children, footer, size = 'md' }: { title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode; size?: 'md' | 'lg' }) {
  return <Modal.Backdrop isOpen onOpenChange={(o) => { if (!o) onClose(); }}>
    <Modal.Container size={size} scroll="inside">
      <Modal.Dialog>
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading>{title}</Modal.Heading></Modal.Header>
        <Modal.Body className="flex flex-col gap-4">{children}</Modal.Body>
        <Modal.Footer className="flex flex-wrap justify-end gap-2">{footer}</Modal.Footer>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}

function useDone(onClose: () => void) {
  const client = useQueryClient();
  return () => { client.invalidateQueries({ queryKey: ['admin', 'users'] }); onClose(); };
}

function CreateUser({ roles, onClose }: { roles: Role[]; onClose: () => void }) {
  const t = useTranslations('Users');
  const { error, field } = useErrorText();
  const done = useDone(onClose);
  const [v, setV] = useState({ email: '', name: '', password: strongPassword(), roles: ['user'] });
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string>();
  async function submit() {
    setBusy(true); setFail(undefined);
    const r = await authClient.admin.createUser({ email: v.email.trim().toLowerCase(), password: v.password, name: v.name.trim(), role: 'user' });
    if (r.error) { setBusy(false); setFail(error(codeOf(r.error))); return; }
    // Roles beyond "user" go through the access API, which checks that you may grant them.
    if (v.roles.join() !== 'user') await apiFetch(`/admin/users/${r.data.user.id}/access`, { method: 'PUT', body: { roles: v.roles, overrides: [] } }).catch((e) => toast.danger(error(e)));
    setBusy(false); toast.success(t('created', { email: v.email })); done();
  }
  return <Dialog title={t('new')} onClose={onClose} footer={<><Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button><Button isPending={busy} onPress={submit}><I name="user-plus" size={16}/>{t('create')}</Button></>}>
    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-semibold">{t('form.identity')}</legend>
      <TextInput label={t('form.email')} type="email" value={v.email} onChange={(email) => setV((x) => ({ ...x, email }))} isRequired autoComplete="off"/>
      <TextInput label={t('form.name')} value={v.name} onChange={(name) => setV((x) => ({ ...x, name }))}/>
    </fieldset>
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-semibold">{t('form.password')}</legend>
      <PasswordInput label={t('form.initialPassword')} value={v.password} onChange={(password) => setV((x) => ({ ...x, password }))}
        help={t('form.passwordHelp')} error={v.password.length > 0 && v.password.length < 12 ? field('PASSWORD_TOO_SHORT') : undefined}/>
    </fieldset>
    <CheckboxList label={t('form.roles')} value={v.roles} onChange={(r) => setV((x) => ({ ...x, roles: r.length ? r : ['user'] }))} options={roles.map((r) => ({ id: r.key, label: r.name }))} help={t('form.rolesHelp')}/>
    {fail && <div role="alert"><Notice tone="danger">{fail}</Notice></div>}
  </Dialog>;
}

function AccessEditor({ user, roles, onClose }: { user: Row; roles: Role[]; onClose: () => void }) {
  const t = useTranslations('Users');
  const tp = useTranslations('Permissions');
  const { error } = useErrorText();
  const done = useDone(onClose);
  const groups = useApiQuery<{ groups: Record<string, string[]> }>(['admin', 'permissions'], '/admin/permissions').data?.groups;
  const current = useApiQuery<{ roles: string[]; overrides: Override[]; effective: string[] }>(['admin', 'access', user.id], `/admin/users/${user.id}/access`).data;
  const [keys, setKeys] = useState<string[] | null>(null);
  const [overrides, setOverrides] = useState<Override[] | null>(null);
  const [busy, setBusy] = useState(false);
  const k = keys ?? current?.roles ?? [];
  const o = overrides ?? current?.overrides ?? [];
  // Live preview of the result, computed the same way as the API.
  const fromRoles = new Set(k.flatMap((r) => roles.find((x) => x.key === r)?.permissions ?? []));
  const isAdmin = fromRoles.has('*');
  const effective = (p: string) => isAdmin || (o.find((x) => x.permission === p)?.effect === 'allow') || (fromRoles.has(p) && o.find((x) => x.permission === p)?.effect !== 'deny');
  const cycle = (p: string) => {
    const now = o.find((x) => x.permission === p)?.effect;
    const next = now === undefined ? (fromRoles.has(p) ? 'deny' : 'allow') : undefined;
    setOverrides([...o.filter((x) => x.permission !== p), ...(next ? [{ permission: p, effect: next as 'allow' | 'deny' }] : [])]);
  };
  async function save() {
    setBusy(true);
    try { await apiFetch(`/admin/users/${user.id}/access`, { method: 'PUT', body: { roles: k, overrides: isAdmin ? [] : o } }); toast.success(t('accessSaved')); done(); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Dialog size="lg" title={t('accessTitle', { email: user.email })} onClose={onClose}
    footer={<><Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button><Button isPending={busy} isDisabled={!current} onPress={save}>{t('save')}</Button></>}>
    <CheckboxList label={t('form.roles')} value={k} onChange={(r) => setKeys(r.length ? r : ['user'])} options={roles.map((r) => ({ id: r.key, label: r.name }))} help={t('rolesExplain')}/>
    {isAdmin ? <Notice tone="accent">{t('adminHasAll')}</Notice> : groups && <div className="flex flex-col gap-3">
      <div><p className="text-sm font-semibold">{t('overridesTitle')}</p><p className="text-xs text-muted">{t('overridesHelp')}</p></div>
      <div className="grid gap-3 md:grid-cols-2">
        {Object.entries(groups).map(([g, list]) => <div key={g} className="rounded-xl border border-border p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{tp(`group.${g}` as 'group.servers')}</p>
          <ul className="flex flex-col gap-1">{list.map((p) => {
            const ov = o.find((x) => x.permission === p)?.effect;
            return <li key={p}>
              <button type="button" onClick={() => cycle(p)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-default">
                <span className={`grid size-5 place-items-center rounded ${effective(p) ? 'bg-success text-success-foreground' : 'bg-default text-muted'}`}>{effective(p) ? <I name="check" size={13}/> : <I name="x" size={13}/>}</span>
                <span className="flex-1">{tp(`p.${p.replace('.', '_')}` as 'p.servers_create')}</span>
                {ov && <Chip size="sm" variant="soft" color={ov === 'allow' ? 'success' : 'danger'}>{t(`effect.${ov}`)}</Chip>}
                {!ov && fromRoles.has(p) && <span className="text-[11px] text-muted">{t('fromRole')}</span>}
              </button>
            </li>;
          })}</ul>
        </div>)}
      </div>
    </div>}
  </Dialog>;
}

function BanUser({ user, onClose }: { user: Row; onClose: () => void }) {
  const t = useTranslations('Users');
  const { error } = useErrorText();
  const done = useDone(onClose);
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('0');
  const [busy, setBusy] = useState(false);
  async function ban() {
    setBusy(true);
    const r = await authClient.admin.banUser({ userId: user.id, banReason: reason || undefined, banExpiresIn: Number(duration) || undefined });
    setBusy(false);
    if (r.error) { toast.danger(error(codeOf(r.error))); return; }
    toast.success(t('bannedDone', { email: user.email })); done();
  }
  return <Dialog title={t('banTitle', { email: user.email })} onClose={onClose} footer={<><Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button><Button variant="danger" isPending={busy} onPress={ban}><I name="ban" size={16}/>{t('action.ban')}</Button></>}>
    <p className="text-sm text-muted">{t('banExplain')}</p>
    <TextInput label={t('banReason')} value={reason} onChange={setReason} maxLength={200} help={t('banReasonHelp')}/>
    <SelectInput label={t('banDuration')} value={duration} onChange={setDuration}
      options={[['0', t('forever')], ['3600', t('hours', { n: 1 })], ['86400', t('days', { n: 1 })], ['604800', t('days', { n: 7 })], ['2592000', t('days', { n: 30 })]].map(([id, label]) => ({ id, label }))}/>
  </Dialog>;
}

function SetPassword({ user, onClose }: { user: Row; onClose: () => void }) {
  const t = useTranslations('Users');
  const { error, field } = useErrorText();
  const done = useDone(onClose);
  const [password, setPassword] = useState(strongPassword());
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const r = await authClient.admin.setUserPassword({ userId: user.id, newPassword: password });
    setBusy(false);
    if (r.error) { toast.danger(error(codeOf(r.error))); return; }
    await navigator.clipboard?.writeText(password).catch(() => undefined);
    toast.success(t('passwordSet')); done();
  }
  return <Dialog title={t('passwordTitle', { email: user.email })} onClose={onClose} footer={<><Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button><Button isPending={busy} isDisabled={password.length < 12} onPress={save}>{t('save')}</Button></>}>
    <Notice tone="warning">{t('passwordExplain')}</Notice>
    <PasswordInput label={t('form.newPassword')} value={password} onChange={setPassword}
      error={password.length < 12 ? field('PASSWORD_TOO_SHORT') : undefined} help={t('form.copiedOnSave')}/>
  </Dialog>;
}

function UserSessions({ user, canRevoke, onClose }: { user: Row; canRevoke: boolean; onClose: () => void }) {
  const t = useTranslations('Users');
  const { error } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ presence: Presence; lastSeen: string | null; sessions: SessionRow[] }>(['admin', 'users', user.id, 'sessions'], `/admin/users/${user.id}/sessions`, { refetchInterval: 15_000 });
  const refresh = () => { void q.refetch(); void client.invalidateQueries({ queryKey: ['admin', 'users'] }); };
  async function end(s?: SessionRow) {
    try {
      if (s) await apiFetch(`/admin/users/${user.id}/sessions/${s.id}`, { method: 'DELETE' });
      else { const r = await authClient.admin.revokeUserSessions({ userId: user.id }); if (r.error) throw codeOf(r.error); }
      toast.success(t('sessionsRevoked')); refresh();
    } catch (e) { toast.danger(error(e)); }
  }
  const d = q.data;
  return <Dialog title={t('sessionsTitle', { email: user.email })} onClose={onClose}
    footer={<>{canRevoke && !!d?.sessions.length && <ConfirmButton variant="danger-soft" label={t('revokeAll')} title={t('revokeAll')} body={t('revokeAllBody', { email: user.email, n: d.sessions.length })} confirmLabel={t('revokeAll')} cancelLabel={t('cancel')} onConfirm={() => end()}/>}<Button variant="tertiary" onPress={onClose}>{t('close')}</Button></>}>
    {!d ? <p role="status" className="text-sm text-muted">…</p> : <div className="flex flex-col gap-3">
      <p className="flex items-center gap-2 text-sm"><PresenceDot presence={d.presence}/><LastSeen presence={d.presence} at={d.lastSeen}/></p>
      <SessionList sessions={d.sessions} onEnd={canRevoke ? (s) => void end(s) : undefined}/>
    </div>}
  </Dialog>;
}

function RemoveUser({ user, onClose }: { user: Row; onClose: () => void }) {
  const t = useTranslations('Users');
  const { error } = useErrorText();
  const done = useDone(onClose);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    const r = await authClient.admin.removeUser({ userId: user.id });
    setBusy(false);
    if (r.error) { toast.danger(error(codeOf(r.error))); return; }
    toast.success(t('removed', { email: user.email })); done();
  }
  return <Dialog title={t('removeTitle', { email: user.email })} onClose={onClose}
    footer={<><Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button><Button variant="danger" isPending={busy} isDisabled={confirm !== user.email || user.servers > 0} onPress={remove}><I name="trash-2" size={16}/>{t('action.remove')}</Button></>}>
    {user.servers > 0 ? <Notice tone="warning">{t('hasServers', { n: user.servers })}</Notice> : <p className="text-sm text-muted">{t('removeExplain')}</p>}
    <TextInput transient label={t('typeEmail', { email: user.email })} value={confirm} onChange={setConfirm} autoComplete="off" spellCheck={false}/>
  </Dialog>;
}

// One action for everyone the list shows now (filter first; up to 200, never yourself): a message through their
// notification channels, or signing them out everywhere. People with more permissions than you are skipped.
function BulkAction({ people, perms, onClose }: { people: Row[]; perms?: string[]; onClose: () => void }) {
  const t = useTranslations('Users.bulk');
  const { error, field } = useErrorText();
  const done = useDone(onClose);
  const actions = (['message', 'end_sessions'] as const).filter((a) => can(perms, a === 'message' ? 'users.manage' : 'users.sessions'));
  const [action, setAction] = useState<string>(actions[0]);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const last = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  // Goes where the caret was, in the subject or the message (the message when neither was touched).
  function insert(v: string) {
    const el = last.current, inSubject = el?.tagName === 'INPUT', cur = inSubject ? subject : message;
    const at = el?.selectionStart ?? cur.length, before = cur.slice(0, at), after = cur.slice(el?.selectionEnd ?? at);
    (inSubject ? setSubject : setMessage)((before + (before && !/\s$/.test(before) ? ' ' : '') + v + after).slice(0, inSubject ? 120 : 2000));
  }
  async function run() {
    setBusy(true); setErrors({});
    try {
      const r = await apiFetch<{ done: number; skipped: number }>('/admin/users/actions', { method: 'POST', body: { action, userIds: people.map((u) => u.id), subject, message } });
      toast.success(t(action === 'message' ? 'sent' : 'ended', { n: r.done, skipped: r.skipped }));
      if (action === 'message') { writeDraft('bulk-message:subject', ''); writeDraft('bulk-message:body', ''); }
      done();
    } catch (e) { const f = (e as { fields?: Record<string, string> })?.fields ?? {}; setErrors(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, field(v) ?? v]))); if (!Object.keys(f).length) toast.danger(error(e)); } finally { setBusy(false); }
  }
  const names = people.slice(0, 4).map((u) => u.name || u.email);
  // Same fill as the API, shown for the first person so a typo is caught before 200 people get it.
  const first = people[0];
  const fill = (s: string) => s.replace(/\{name\}/g, first?.name?.trim() || first?.email || '').replace(/\{email\}/g, first?.email ?? '');
  const personal = /\{(name|email)\}/.test(subject + message);
  const unknown = [...new Set((subject + message).match(/\{[^{}\s]+\}/g) ?? [])].filter((v) => v !== '{name}' && v !== '{email}');
  return <Dialog title={t('title', { n: people.length })} onClose={onClose}
    footer={<><Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button>
      <Button variant={action === 'message' ? 'primary' : 'danger'} isPending={busy} isDisabled={action === 'message' && (!subject.trim() || !message.trim())} onPress={() => void run()}>
        {action === 'message' ? <I name="send" size={15}/> : <I name="log-out" size={15}/>}{t(action === 'message' ? 'send' : 'end', { n: people.length })}</Button></>}>
    <p className="text-sm text-muted">{t('who', { names: names.join(', '), more: Math.max(people.length - names.length, 0) })}</p>
    <SelectInput label={t('action')} value={action} onChange={setAction} options={actions.map((a) => ({ id: a, label: t(`action_${a}`) }))}/>
    {action === 'message' ? <div className="contents" onFocusCapture={(e) => { if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) last.current = e.target; }}>
      <TextInput draft="bulk-message:subject" label={t('subject')} value={subject} onChange={setSubject} maxLength={120} isRequired error={errors.subject} autoComplete="off"/>
      <TextInput draft="bulk-message:body" label={t('message')} value={message} onChange={setMessage} maxLength={2000} multiline isRequired error={errors.message} autoComplete="off"
        help={t('messageHelp', { name: '{name}', email: '{email}' })}/>
      <div className="flex flex-wrap gap-2">
        {['{name}', '{email}'].map((v) => <Button key={v} size="sm" variant="secondary" aria-label={t('insert', { field: v })} onPress={() => insert(v)}>
          <I name="plus" size={14}/><span className="font-mono">{v}</span></Button>)}
      </div>
      {unknown.length > 0 && <Notice tone="warning">{t('unknown', { list: unknown.join(', '), name: '{name}', email: '{email}' })}</Notice>}
      {personal && first && message.trim() && <figure className="rounded-md border border-border p-3 text-sm" aria-label={t('preview', { who: first.name || first.email })}>
        <figcaption className="mb-1 text-xs text-muted">{t('preview', { who: first.name || first.email })}</figcaption>
        <p className="font-medium">{fill(subject).slice(0, 120)}</p>
        <p className="whitespace-pre-wrap break-words text-muted">{fill(message)}</p>
      </figure>}
    </div> : <Notice tone="warning">{t('endHelp')}</Notice>}
  </Dialog>;
}
