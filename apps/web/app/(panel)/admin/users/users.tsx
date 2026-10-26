"use client";
// User management: better-auth's admin API (create, ban, password, sessions, impersonation, removal) and
// the panel's access API (roles + per-user permission overrides). Buttons appear only with the permission.
import { Avatar, Button, Chip, Dropdown, Label, Modal, SearchField, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { I } from '../../../../components/icon';
import { CheckboxList, DataTable, Notice, PageHeader, SelectInput, StatusChip, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { authClient } from '../../../../lib/auth-client';
import { useMe } from '../../../../lib/me';
import { can } from '../../../../lib/permissions';
import { useApiQuery } from '../../../../lib/query';

type Row = { id: string; email: string; name: string; role: string; locale: string; createdAt: string; banned: boolean; banReason: string | null; banExpires: string | null;
  twoFactorEnabled: boolean; authSource?: string; lastLoginMethod: string | null; phoneNumber: string | null; servers: number; sessions: number; lastSeen: string | null; overrides: number };
type Role = { key: string; name: string; description: string; permissions: string[]; builtin: boolean; members: number };
type Override = { permission: string; effect: 'allow' | 'deny' };
type ClientError = { code?: string; status?: number } | null;
const codeOf = (e: ClientError) => ({ code: e?.code ?? (e?.status === 429 ? 'RATE_LIMITED' : 'UNKNOWN') });
const strongPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'[b % 56]).join('');

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
  const [dialog, setDialog] = useState<{ kind: 'create' | 'access' | 'ban' | 'password' | 'sessions' | 'remove'; user?: Row }>();
  const tr = useTranslations('Roles');
  const roleName = (k: string) => (tr.has(`builtinName.${k}` as 'builtinName.admin') ? tr(`builtinName.${k}` as 'builtinName.admin') : roles.find((r) => r.key === k)?.name ?? k);

  const rows = useMemo(() => (users ?? []).filter((u) => {
    const q = search.trim().toLocaleLowerCase('tr');
    if (q && !`${u.email} ${u.name} ${u.phoneNumber ?? ''}`.toLocaleLowerCase('tr').includes(q)) return false;
    if (role && !u.role.split(',').includes(role)) return false;
    if (status === 'banned' && !u.banned) return false;
    if (status === 'active' && u.banned) return false;
    if (status === 'no2fa' && u.twoFactorEnabled) return false;
    return true;
  }), [users, search, role, status]);

  const stats = users && { total: users.length, banned: users.filter((u) => u.banned).length, twoFactor: users.filter((u) => u.twoFactorEnabled).length,
    staff: users.filter((u) => u.role.split(',').some((r) => r !== 'user')).length };

  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')}
      actions={can(perms, 'users.manage') && <Button onPress={() => setDialog({ kind: 'create' })}><I name="user-plus" size={16}/>{t('new')}</Button>}/>
    {stats && <ul className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
      {([['total', 'users'], ['staff', 'shield-check'], ['twoFactor', 'lock'], ['banned', 'ban']] as const).map(([k, icon]) => <li key={k} className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
        <span className="grid size-9 place-items-center rounded-lg bg-default text-muted">{icon === 'users' ? <I name="users" size={16}/> : icon === 'shield-check' ? <I name="shield-check" size={16}/> : icon === 'lock' ? <I name="lock" size={16}/> : <I name="ban" size={16}/>}</span>
        <span><span className="block text-lg font-semibold tabular-nums">{stats[k]}</span><span className="text-xs text-muted">{t(`stat.${k}`)}</span></span>
      </li>)}
    </ul>}
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <SearchField aria-label={t('search')} value={search} onChange={(v) => void setSearch(v || null)} className="min-w-64 flex-1">
        <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('search')}/><SearchField.ClearButton/></SearchField.Group>
      </SearchField>
      <SelectInput className="w-44" label={t('filterRole')} value={role} onChange={(v) => void setRole(v || null)} options={[{ id: '', label: t('all') }, ...roles.map((r) => ({ id: r.key, label: roleName(r.key) }))]}/>
      <SelectInput className="w-44" label={t('filterStatus')} value={status} onChange={(v) => void setStatus(v || null)}
        options={[{ id: '', label: t('all') }, { id: 'active', label: t('active') }, { id: 'banned', label: t('banned') }, { id: 'no2fa', label: t('no2fa') }]}/>
    </div>
    <DataTable label={t('title')} rows={rows} rowKey={(u) => u.id} empty={users ? t('empty') : '…'} minWidth={900}
      columns={[{ id: 'user', label: t('col.user') }, { id: 'roles', label: t('col.roles') }, { id: 'status', label: t('col.status') }, { id: 'security', label: t('col.security') },
        { id: 'servers', label: t('col.servers') }, { id: 'seen', label: t('col.lastSeen') }, { id: 'act', label: <span className="sr-only">{t('col.actions')}</span> }]}
      cells={(u) => [
        <span key="u" className="flex min-w-0 items-center gap-3">
          <Avatar size="sm"><Avatar.Fallback>{(u.name || u.email).slice(0, 2).toUpperCase()}</Avatar.Fallback></Avatar>
          <span className="min-w-0"><span className="block truncate font-medium">{u.name || u.email}</span>{u.name && <span className="block truncate text-xs text-muted">{u.email}</span>}</span>
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
        <span key="srv" className="tabular-nums">{u.servers}</span>,
        <span key="seen" className="text-xs text-muted">{u.lastSeen ? format.relativeTime(new Date(u.lastSeen), now) : t('never')}</span>,
        <RowActions key="a" user={u} self={u.id === me?.id} perms={perms} open={(kind) => setDialog({ kind, user: u })}/>,
      ]}/>
    {dialog?.kind === 'create' && <CreateUser roles={roles} onClose={() => setDialog(undefined)}/>}
    {dialog?.kind === 'access' && dialog.user && <AccessEditor user={dialog.user} roles={roles} onClose={() => setDialog(undefined)}/>}
    {dialog?.kind === 'ban' && dialog.user && <BanUser user={dialog.user} onClose={() => setDialog(undefined)}/>}
    {dialog?.kind === 'password' && dialog.user && <SetPassword user={dialog.user} onClose={() => setDialog(undefined)}/>}
    {dialog?.kind === 'sessions' && dialog.user && <UserSessions user={dialog.user} canRevoke={can(perms, 'users.sessions')} onClose={() => setDialog(undefined)}/>}
    {dialog?.kind === 'remove' && dialog.user && <RemoveUser user={dialog.user} onClose={() => setDialog(undefined)}/>}
  </>;
}

function RowActions({ user, self, perms, open }: { user: Row; self: boolean; perms?: string[]; open: (k: 'access' | 'ban' | 'password' | 'sessions' | 'remove') => void }) {
  const t = useTranslations('Users');
  const { error } = useErrorText();
  const router = useRouter();
  const client = useQueryClient();
  async function act(k: string) {
    if (k === 'impersonate') {
      const r = await authClient.admin.impersonateUser({ userId: user.id });
      if (r.error) { toast.danger(error(codeOf(r.error))); return; }
      router.replace('/'); router.refresh(); return;
    }
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
  return <Dropdown>
    <Button isIconOnly size="sm" variant="ghost" aria-label={t('actionsFor', { email: user.email })}><I name="ellipsis" size={18}/></Button>
    <Dropdown.Popover placement="bottom end">
      <Dropdown.Menu aria-label={t('actionsFor', { email: user.email })} onAction={(k) => void act(String(k))}>
        {visible.map(([id, label, icon]) => <Dropdown.Item key={id} id={id} textValue={label} variant={id === 'remove' || id === 'ban' ? 'danger' : 'default'}>{icon}<Label>{label}</Label></Dropdown.Item>)}
      </Dropdown.Menu>
    </Dropdown.Popover>
  </Dropdown>;
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
      <div className="flex items-end gap-2"><TextInput className="flex-1" label={t('form.initialPassword')} value={v.password} onChange={(password) => setV((x) => ({ ...x, password }))}
        help={t('form.passwordHelp')} error={v.password.length && v.password.length < 12 ? field('PASSWORD_TOO_SHORT') : undefined} spellCheck={false}/>
        <Button isIconOnly variant="secondary" aria-label={t('form.generate')} className="mb-6" onPress={() => setV((x) => ({ ...x, password: strongPassword() }))}><I name="refresh-cw" size={16}/></Button></div>
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
    <div className="flex items-end gap-2"><TextInput className="flex-1" label={t('form.newPassword')} value={password} onChange={setPassword} spellCheck={false}
      error={password.length < 12 ? field('PASSWORD_TOO_SHORT') : undefined} help={t('form.copiedOnSave')}/>
      <Button isIconOnly variant="secondary" aria-label={t('form.generate')} className="mb-6" onPress={() => setPassword(strongPassword())}><I name="refresh-cw" size={16}/></Button></div>
  </Dialog>;
}

function UserSessions({ user, canRevoke, onClose }: { user: Row; canRevoke: boolean; onClose: () => void }) {
  const t = useTranslations('Users');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { error } = useErrorText();
  const [list, setList] = useState<{ token: string; ipAddress?: string | null; userAgent?: string | null; createdAt: Date; impersonatedBy?: string | null }[] | null>(null);
  const load = async () => { const r = await authClient.admin.listUserSessions({ userId: user.id }); if (r.error) toast.danger(error(codeOf(r.error))); else setList(r.data.sessions); };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function revoke(token?: string) {
    const r = token ? await authClient.admin.revokeUserSession({ sessionToken: token }) : await authClient.admin.revokeUserSessions({ userId: user.id });
    if (r.error) { toast.danger(error(codeOf(r.error))); return; }
    toast.success(t('sessionsRevoked')); await load();
  }
  return <Dialog title={t('sessionsTitle', { email: user.email })} onClose={onClose}
    footer={<>{canRevoke && !!list?.length && <Button variant="danger-soft" onPress={() => revoke()}>{t('revokeAll')}</Button>}<Button variant="tertiary" onPress={onClose}>{t('close')}</Button></>}>
    {list === null ? <p role="status" className="text-sm text-muted">…</p> : list.length === 0 ? <p className="text-sm text-muted">{t('noSessions')}</p>
      : <ul className="flex flex-col divide-y divide-separator rounded-lg border border-border">{list.map((s) => <li key={s.token} className="flex items-center gap-3 px-3 py-2.5 text-sm">
          {/mobile|android|iphone/i.test(s.userAgent ?? '') ? <I name="smartphone" size={16} className="text-muted"/> : <I name="monitor" size={16} className="text-muted"/>}
          <span className="min-w-0 flex-1"><span className="block truncate">{s.userAgent?.slice(0, 70) ?? '–'}</span>
            <span className="text-xs text-muted">{s.ipAddress ?? '–'} · {format.relativeTime(new Date(s.createdAt), now)}{s.impersonatedBy && ` · ${t('impersonated')}`}</span></span>
          {canRevoke && <Button size="sm" variant="ghost" onPress={() => revoke(s.token)}>{t('revoke')}</Button>}
        </li>)}</ul>}
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
    <TextInput label={t('typeEmail', { email: user.email })} value={confirm} onChange={setConfirm} autoComplete="off" spellCheck={false}/>
  </Dialog>;
}
