"use client";
import { Button, Card, ProgressBar, toast } from '@heroui/react';
import { I } from '../../components/icon';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { motion } from 'motion/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { apiFetch, useErrorText } from '../../lib/api';
import { useApiForm } from '../../lib/form';
import { useApiAction, useApiQuery } from '../../lib/query';
import ServerMetrics from './metrics';
import { ServerIso } from './server-iso';
import { ServerHealth } from '../../components/smart';
import { OrderSimilar, QuickConnect, ServerLabels } from './server-extras';
import { remember } from '../../lib/recent';
import { PowerSchedules } from './server-schedules';
import { ServerSnapshots } from './server-snapshots';
import { ServerFilters, useServerFilters } from './server-filters';
import { flag } from '../../lib/flag';
import { ButtonLink, ConfirmButton, DataTable, Empty, Mono, Notice, PageHeader, Section, StatusChip, TextInput, type Tone } from '../../components/ui';

export type Server = { id: string; name: string; state: string; powerState: string; guestReady: boolean; vcpu: number; memoryMb: number; diskGb: number;
  priceMonthly: string; currency: string; errorCode: string | null; poolName: string; location: string; locationCity?: string | null; locationCountry?: string | null; locationDatacenter?: string | null; imageName: string; address: string | null;
  createdAt: string; favorite?: boolean; locked?: boolean; tags?: string[]; notes?: string; poolId: string; imageId: string; packageId: string | null; vdcId?: string | null; ownerEmail?: string; hasRootPassword?: boolean; applicationName?: string | null; appState?: 'pending' | 'installing' | 'installed' | 'failed' | null; appMessage?: string | null; firewallStatus?: 'applied' | 'pending' | 'failed'; firewallError?: string | null; firewallCount?: number; lastOperation: { id: string; kind: string; status: string; step: string | null; errorCode: string | null } | null };
type Operation = { id: string; kind: string; status: string; step: string | null; attempts: number; errorCode: string | null; createdAt: string; finishedAt: string | null };

// One Idempotency-Key per user intention: a double click or a retry after a timeout reuses it,
// so the server never receives two different "create" requests for one click.
export function useIntentKey() {
  const ref = useRef<string>(undefined);
  return { key: () => (ref.current ??= crypto.randomUUID()), reset: () => { ref.current = undefined; } };
}

// Platform state, VMware power state and guest readiness stay separate: "on" is not "ready".
export function StateBadge({ server }: { server: Pick<Server, 'state' | 'powerState' | 'guestReady'> }) {
  const t = useTranslations('Servers');
  const tone: Tone = server.state === 'ready' ? (server.powerState === 'poweredOn' && server.guestReady ? 'success' : server.powerState === 'poweredOn' ? 'warning' : 'default')
    : server.state === 'error' || server.state === 'missing' ? 'danger' : 'accent';
  const text = `${t(`state.${server.state as 'ready'}`)}${server.state === 'ready' ? ` · ${t(`power.${server.powerState as 'poweredOn'}`)}` : ''}${server.state === 'ready' && server.powerState === 'poweredOn' && !server.guestReady ? ` · ${t('guestNotReady')}` : ''}`;
  return <StatusChip tone={tone}>{text}</StatusChip>;
}

const size = (t: ReturnType<typeof useTranslations<'Servers'>>, s: Pick<Server, 'vcpu' | 'memoryMb' | 'diskGb'>) => t('size', { vcpu: s.vcpu, memory: s.memoryMb / 1024, disk: s.diskGb });

export type SshKey = { id: string; name: string; fingerprint: string };
export const useSshKeys = () => useApiQuery<{ keys: SshKey[] }>(['ssh-keys'], '/ssh-keys').data?.keys ?? [];

export function SshKeys() {
  const t = useTranslations('Servers');
  const client = useQueryClient();
  const keys = useSshKeys();
  const [listRef] = useAutoAnimate<HTMLUListElement>();
  const f = useApiForm({ name: '', publicKey: '' });
  const gh = useApiForm({ username: '' });
  const remove = useApiAction((id: string) => apiFetch(`/ssh-keys/${id}`, { method: 'DELETE' }), { invalidate: [['ssh-keys']] });
  return <Section title={t('keys.title')} description={t('keys.explain')}>
    <div className="flex flex-col gap-5">
      {keys.length > 0 && <ul ref={listRef} className="flex flex-col divide-y divide-separator rounded-lg border border-border">
        {keys.map((k) => <li key={k.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <I name="key-round" size={16} className="text-muted"/>
          <span className="font-medium">{k.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{k.fingerprint}</span>
          <Button size="sm" variant="ghost" aria-label={`${t('keys.remove')}: ${k.name}`} onPress={() => remove.mutate(k.id)}><I name="trash-2" size={15}/>{t('keys.remove')}</Button>
        </li>)}
      </ul>}
      <form className="grid gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] md:items-start" noValidate
        onSubmit={async (e) => { e.preventDefault(); if (await f.submit('POST', '/ssh-keys')) { f.reset(); client.invalidateQueries({ queryKey: ['ssh-keys'] }); toast.success(t('keys.added')); } }}>
        <TextInput label={t('keys.name')} value={f.values.name} onChange={f.set('name')} error={f.fieldError('name')}/>
        <TextInput label={t('keys.publicKey')} value={f.values.publicKey} onChange={f.set('publicKey')} error={f.fieldError('publicKey')} help={t('keys.publicKeyHelp')}
          placeholder="ssh-ed25519 AAAA… user@host" spellCheck={false}/>
        <Button type="submit" className="md:mt-6" isPending={f.busy}><I name="plus" size={16}/>{t('keys.add')}</Button>
      </form>
      <form className="flex flex-col gap-3 border-t border-separator pt-4 sm:flex-row sm:items-start" noValidate
        onSubmit={async (e) => { e.preventDefault(); const r = await gh.submit<{ added: number; skipped: number }>('POST', '/ssh-keys/github');
          if (r) { gh.reset(); client.invalidateQueries({ queryKey: ['ssh-keys'] }); toast.success(t('keys.githubDone', { added: r.added, skipped: r.skipped })); } }}>
        <TextInput className="sm:w-72" label={t('keys.github')} value={gh.values.username} onChange={gh.set('username')} error={gh.fieldError('username')} help={t('keys.githubHelp')}
          placeholder="octocat" spellCheck={false} autoComplete="off"/>
        <Button type="submit" variant="secondary" className="sm:mt-6" isPending={gh.busy} isDisabled={!gh.values.username.trim()}><I name="github" size={16}/>{t('keys.githubImport')}</Button>
      </form>
    </div>
  </Section>;
}

export function ServerList() {
  const t = useTranslations('Servers');
  const tn = useTranslations('Nav');
  const servers = useApiQuery<{ servers: Server[] }>(['servers'], '/servers', { refetchInterval: 5_000 }).data?.servers;
  const [gridRef] = useAutoAnimate<HTMLUListElement>();
  const f = useServerFilters(servers ?? []);
  if (!servers) return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-busy>{[0, 1, 2].map((i) => <Card key={i} className="h-36 animate-pulse"><span className="sr-only">…</span></Card>)}</div>;
  if (!servers.length) return <Empty icon={<I name="server" size={28}/>} title={t('list.empty')}><ButtonLink href="/order" className="mt-3"><I name="plus" size={16}/>{tn('newServer')}</ButtonLink></Empty>;
  // Starred servers first, the rest in their order.
  const shown = [...f.shown].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite));
  return <div className="flex flex-col gap-4">
    {(servers.length > 1 || f.q || f.state !== 'all' || f.tag) && <div className="rounded-xl border border-border bg-surface p-3"><ServerFilters f={f} placeholder={t('list.searchPlaceholder')}/></div>}
    {!shown.length ? <p role="status" className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">{t('list.noMatch')}</p>
    : <ul ref={gridRef} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-label={t('list.title')}>
    {shown.map((s, i) => <motion.li key={s.id} className="relative" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.05, duration: 0.25 }}>
      <NextLink href={`/servers/${s.id}`} className="block rounded-xl outline-offset-2 transition-all duration-200 hover:-translate-y-1 hover:shadow-lg focus-visible:outline-2">
        <Card className="h-full">
          <Card.Header className="flex flex-row items-start justify-between gap-2">
            <div className="min-w-0"><Card.Title className="flex items-center gap-1.5 truncate text-base font-semibold">{s.name}{s.locked && <I name="lock" size={13} className="shrink-0 text-warning"/>}</Card.Title>
              <Card.Description className="flex items-center gap-1 text-xs text-muted"><I name="map-pin" size={12}/>{s.location || s.poolName}</Card.Description></div>
            <StateBadge server={s}/>
          </Card.Header>
          <Card.Content className="flex flex-col gap-1.5 text-sm">
            <span className="flex items-center gap-2"><span className="text-muted">IP</span>{s.address ? <Mono>{s.address}</Mono> : '–'}</span>
            <span className="flex items-center gap-2 text-muted"><I name="cpu" size={14}/>{size(t, s)}</span>
            <span className="truncate text-xs text-muted">{s.imageName}</span>
            {!!s.tags?.length && <span className="flex flex-wrap gap-1 pt-1">{s.tags.map((x) => <span key={x} className="rounded-full bg-default px-2 py-0.5 text-xs">{x}</span>)}</span>}
          </Card.Content>
        </Card>
      </NextLink>
      <FavoriteStar id={s.id} on={!!s.favorite} name={s.name}/>
    </motion.li>)}
  </ul>}
  </div>;
}

// Star / unstar a server; the list updates at once and is put right if the request fails.
export function FavoriteStar({ id, on, name, listKey = ['servers'], className = 'absolute bottom-3 right-3' }: { id: string; on: boolean; name: string; listKey?: string[]; className?: string }) {
  const t = useTranslations('Servers');
  const client = useQueryClient();
  const flip = async () => {
    client.setQueryData<{ servers: Server[] }>(listKey, (d) => d && { servers: d.servers.map((x) => (x.id === id ? { ...x, favorite: !on } : x)) });
    await apiFetch(`/servers/${id}/favorite`, { method: on ? 'DELETE' : 'PUT' }).catch(() => undefined);
    void client.invalidateQueries({ queryKey: listKey });
  };
  return <button type="button" onClick={flip} aria-pressed={on} aria-label={on ? t('unstar', { name }) : t('star', { name })}
    className={`${className} grid size-9 place-items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-accent ${on ? 'text-warning hover:bg-warning/10' : 'text-muted hover:bg-default hover:text-foreground'}`}>
    <motion.span key={String(on)} initial={{ scale: on ? 0.4 : 1 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 15 }}>
      <I name="star" size={17} className={on ? 'fill-current' : ''}/></motion.span>
  </button>;
}

// Delete protection: a calm bar while unlocked, a clear warning-coloured one while locked.
function LockBar({ id, locked, canChange }: { id: string; locked: boolean; canChange: boolean }) {
  const t = useTranslations('Servers.lock');
  const { error } = useErrorText();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function flip() {
    setBusy(true);
    try { await apiFetch(`/servers/${id}/lock`, { method: 'PUT', body: { locked: !locked } }); toast.success(locked ? t('unlocked') : t('lockedNow')); void client.invalidateQueries({ queryKey: ['server', id] }); void client.invalidateQueries({ queryKey: ['servers'] }); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <motion.div layout className={`flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 ${locked ? 'border-warning/40 bg-warning/10' : 'border-border bg-surface'}`}>
    <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${locked ? 'bg-warning/20 text-warning' : 'bg-default text-muted'}`}><I name={locked ? 'lock' : 'lock-open'} size={17}/></span>
    <div className="min-w-0 flex-1"><p className="text-sm font-medium">{locked ? t('onTitle') : t('offTitle')}</p><p className="text-xs text-muted">{locked ? t('onHelp') : t('offHelp')}</p></div>
    {canChange && <Button size="sm" variant={locked ? 'secondary' : 'ghost'} isPending={busy} onPress={flip}><I name={locked ? 'lock-open' : 'lock'} size={14}/>{locked ? t('unlock') : t('lock')}</Button>}
  </motion.div>;
}

const runningStates = ['pending', 'running'];

export function ServerDetail({ id }: { id: string }) {
  const t = useTranslations('Servers');
  const format = useFormatter();
  const { error } = useErrorText();
  const router = useRouter();
  const intent = useIntentKey();
  const client = useQueryClient();
  const [message, setMessage] = useState<string>();
  const [deleteName, setDeleteName] = useState('');
  const q = useApiQuery<{ server: Server; operations: Operation[]; own?: boolean; allowed?: Record<'power' | 'console' | 'iso' | 'rootPassword' | 'delete' | 'snapshots', boolean> }>(['servers', id], `/servers/${id}`, { refetchInterval: 3_000 });
  const gone = (q.error as { code?: string } | null)?.code === 'NOT_FOUND';
  // The viewer's own server names, for the next free name in "order similar".
  const mine = useApiQuery<{ servers: Server[] }>(['servers'], '/servers').data?.servers;
  const name = q.data?.server.name;
  useEffect(() => { if (name) remember({ href: `/servers/${id}`, label: name }); }, [name, id]);
  useEffect(() => { if (gone) router.replace('/'); }, [gone, router]);
  if (!q.data) return <p role="status" className="text-sm text-muted">{q.error && !gone ? error(q.error) : t('loading')}</p>;
  const { server: s, operations } = q.data;
  // What the admin lets customers do here (missing: an older API, everything allowed).
  const allowed = { power: true, console: true, iso: true, rootPassword: true, delete: true, snapshots: true, ...q.data.allowed };
  const open = operations.find((o) => runningStates.includes(o.status));
  const own = !!q.data.own; // owner-only helpers: tags and notes, order similar
  // The same Idempotency-Key is kept until the server answers; only a network failure keeps it for a retry.
  async function act(path: string, method: string, body?: object) {
    setMessage(undefined);
    try { await apiFetch(path, { method, body, headers: { 'idempotency-key': intent.key() } }); intent.reset(); client.invalidateQueries({ queryKey: ['servers'] }); client.invalidateQueries({ queryKey: ['tasks'] }); }
    catch (e) { setMessage(error(e)); toast.danger(error(e)); if ((e as { code?: string }).code !== 'NETWORK') intent.reset(); }
  }
  const canAct = !open && ['ready', 'error'].includes(s.state);
  // Locked: what would end the server or lose its state waits until it is unlocked (the API refuses it too).
  const locked = !!s.locked;
  const actionLabel = (a: string) => t(`action.${a as 'power_on'}`);
  const power = (action: string, icon: React.ReactNode) => <Button variant="secondary" isDisabled={!canAct} onPress={() => act(`/servers/${id}/actions`, 'POST', { action })}>{icon}{actionLabel(action)}</Button>;
  const risky = (action: 'power_off' | 'reset', icon: React.ReactNode) => <ConfirmButton variant="danger-soft" isDisabled={!canAct || locked} icon={icon} label={actionLabel(action)}
    title={actionLabel(action)} body={t(`confirm.${action}`)} confirmLabel={t('confirm.yes', { action: actionLabel(action) })} cancelLabel={t('confirm.no')}
    onConfirm={() => act(`/servers/${id}/actions`, 'POST', { action })}/>;

  return <div className="flex flex-col gap-6">
    <PageHeader eyebrow={s.location || s.poolName} title={s.name} description={<span className="mt-2 inline-flex"><StateBadge server={s}/></span>}
      actions={<>{s.state === 'ready' && allowed.console && <ButtonLink variant="secondary" href={`/servers/${id}/console`}><I name="square-terminal" size={16}/>{actionLabel('console')}</ButtonLink>}
        {own && <ButtonLink variant="ghost" href={`/support?new=1&server=${id}`}><I name="life-buoy" size={16}/>{t('getSupport')}</ButtonLink>}
        {own && <OrderSimilar server={s} names={(mine ?? []).map((x) => x.name)}/>}</>}/>
    {message && <div role="alert"><Notice tone="danger">{message}</Notice></div>}
    <LockBar id={id} locked={locked} canChange={own || allowed.delete}/>
    {s.errorCode && <Notice tone="danger">{t('errorCode', { message: error({ code: s.errorCode }), code: s.errorCode })}</Notice>}

    {open && <Section title={t('detail.progress')}>
      <div className="flex flex-col gap-3">
        <p role="status" className="text-sm">{t(`kind.${open.kind as 'create'}`)}: {t(`step.${(open.step ?? 'queued') as 'queued'}`)}{open.attempts > 1 && ` · ${t('attempt', { n: open.attempts })}`}</p>
        <ProgressBar aria-label={t('detail.progress')} isIndeterminate size="sm"><ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>
        {open.kind === 'create' && <div><Button size="sm" variant="secondary" onPress={() => act(`/servers/${id}/operations/${open.id}/cancel`, 'POST')}>{actionLabel('cancel')}</Button></div>}
      </div>
    </Section>}

    <div className="grid gap-6 lg:grid-cols-3">
      <Section title={t('detail.overview')} className="lg:col-span-2">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted">IP</dt><dd className="mt-0.5">{s.address ? <Mono>{s.address}</Mono> : '–'}</dd></div>
          <div><dt className="text-muted">{t('col.size')}</dt><dd className="mt-0.5">{size(t, s)}</dd></div>
          <div><dt className="text-muted">{t('detail.location')}</dt><dd className="mt-0.5 flex flex-col">
            <span><span aria-hidden className="mr-1.5">{flag(s.locationCountry ?? '')}</span>{s.location || s.poolName}</span>
            {(s.locationCity || s.locationDatacenter) && <span className="text-xs text-muted">{[s.locationCity, s.locationDatacenter].filter(Boolean).join(' · ')}</span>}</dd></div>
          <div><dt className="text-muted">{t('detail.image')}</dt><dd className="mt-0.5">{s.imageName}</dd></div>
          <div><dt className="text-muted">{t('detail.price')}</dt><dd className="mt-0.5">{format.number(Number(s.priceMonthly), { style: 'currency', currency: s.currency })}</dd></div>
          {s.applicationName && <div><dt className="text-muted">{t('detail.application')}</dt><dd className="mt-0.5 flex flex-wrap items-center gap-2">{s.applicationName}
            {s.appState && <StatusChip tone={s.appState === 'installed' ? 'success' : s.appState === 'failed' ? 'danger' : 'accent'}>{t(`appState.${s.appState}`)}</StatusChip>}
            {s.appState === 'failed' && s.appMessage && <span className="text-xs text-muted">{s.appMessage}</span>}</dd></div>}
          <div><dt className="text-muted">{t('detail.created')}</dt><dd className="mt-0.5">{format.dateTime(new Date(s.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>
        </dl>
        <p className="mt-4 text-xs text-muted">{t('readinessExplain')}</p>
      </Section>
      {allowed.power && <Section title={t('detail.power')} description={t('powerExplain')}>
        <div className="flex flex-wrap gap-2">
          {power('power_on', <I name="play" size={16}/>)}
          {power('shutdown', <I name="power" size={16}/>)}
          {risky('power_off', <I name="square" size={16}/>)}
          {risky('reset', <I name="rotate-ccw" size={16}/>)}
        </div>
      </Section>}
    </div>

    <div className={`grid grid-cols-1 gap-6 ${s.address ? 'lg:grid-cols-2' : ''}`}><ServerHealth id={s.id}/><QuickConnect server={s}/></div>
    {own && <ServerLabels key={`${s.tags?.join()}|${s.notes}`} server={s}/>}
    {own && (allowed.power || allowed.snapshots) && s.state !== 'provisioning' && <PowerSchedules serverId={s.id} power={allowed.power} snapshots={allowed.snapshots}/>}
    {allowed.snapshots && ['ready', 'error'].includes(s.state) && <ServerSnapshots serverId={s.id} busy={!!open}/>}
    <ServerIps server={s}/>
    {allowed.iso && <ServerIso id={s.id} ready={s.state === 'ready' || s.state === 'error'}/>}
    {s.hasRootPassword && allowed.rootPassword && <RootPassword id={s.id}/>}
    <ServerFirewalls server={s}/>

    <ServerMetrics id={id} live={s.state === 'ready' && s.powerState === 'poweredOn'}/>

    <Section title={t('detail.history')}>
      <DataTable label={t('detail.history')} rows={operations} rowKey={(o) => o.id}
        columns={[{ id: 'when', label: t('col.when') }, { id: 'op', label: t('col.operation') }, { id: 'state', label: t('col.state') }, { id: 'detail', label: t('col.detail') }]}
        cells={(o) => [format.dateTime(new Date(o.createdAt), { dateStyle: 'short', timeStyle: 'medium' }), t(`kind.${o.kind as 'create'}`),
          <StatusChip key="s" tone={o.status === 'succeeded' ? 'success' : o.status === 'failed' ? 'danger' : o.status === 'cancelled' ? 'default' : 'accent'}>{t(`opStatus.${o.status as 'pending'}`)}</StatusChip>,
          o.errorCode ? t('errorCode', { message: error({ code: o.errorCode }), code: o.errorCode }) : o.step ? t(`step.${o.step as 'queued'}`) : '']}/>
    </Section>

    {allowed.delete && <Section title={t('delete.title')} description={t('delete.explain')} className="border border-danger/30">
      <div className="flex flex-wrap items-end gap-3">
        <TextInput className="min-w-64 flex-1" label={t('delete.confirm', { name: s.name })} value={deleteName} onChange={setDeleteName} autoComplete="off"/>
        <Button variant="danger" isDisabled={deleteName !== s.name || s.state === 'deleting' || locked} onPress={() => act(`/servers/${id}`, 'DELETE', { confirm: deleteName })}>
          <I name="trash-2" size={16}/>{t('delete.button')}</Button>
      </div>
    </Section>}
  </div>;
}

// The firewalls protecting this server and whether VMware has their current rules.
// The root password chosen (or generated) at order time: shown on request, and the panel's copy can be forgotten.
function RootPassword({ id }: { id: string }) {
  const t = useTranslations('Servers.password');
  const { error } = useErrorText();
  const client = useQueryClient();
  const [shown, setShown] = useState<string>();
  async function reveal() {
    try { setShown((await apiFetch<{ password: string }>(`/servers/${id}/root-password`)).password); } catch (e) { toast.danger(error(e)); }
  }
  async function forget() {
    try { await apiFetch(`/servers/${id}/root-password`, { method: 'DELETE' }); setShown(undefined); toast.success(t('forgotten')); client.invalidateQueries({ queryKey: ['servers', id] }); }
    catch (e) { toast.danger(error(e)); throw e; }
  }
  return <Section title={t('title')} description={t('help')}>
    <div className="flex flex-wrap items-center gap-2">
      {shown ? <><Mono>{shown}</Mono><Button size="sm" variant="ghost" onPress={() => { navigator.clipboard?.writeText(shown); toast.success(t('copied')); }}><I name="copy" size={14}/>{t('copy')}</Button>
          <Button size="sm" variant="ghost" onPress={() => setShown(undefined)}><I name="eye-off" size={14}/>{t('hide')}</Button></>
        : <Button size="sm" variant="secondary" onPress={reveal}><I name="eye" size={14}/>{t('show')}</Button>}
      <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={t('forget')} title={t('forgetTitle')} body={t('forgetBody')}
        confirmLabel={t('forget')} cancelLabel={t('cancel')} onConfirm={forget}/>
    </div>
  </Section>;
}

// The server's addresses (primary, extra IPv4, IPv6) and their reverse DNS, editable when the admin allows it.
function ServerIps({ server }: { server: Server }) {
  const t = useTranslations('Servers.ips');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ addresses: { address: string; family: number; kind: 'primary' | 'extra' | 'ipv6'; ptr: string | null }[]; rdns: { enabled: boolean; customerEdit: boolean; forwardCheck: boolean } }>(
    ['servers', server.id, 'ips'], `/servers/${server.id}/ips`);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!q.data || q.data.addresses.length === 0) return null;
  const { addresses, rdns } = q.data;
  async function save(address: string, ptr: string) {
    setBusy(true); setFieldError(undefined);
    try {
      await apiFetch(`/servers/${server.id}/ips/${encodeURIComponent(address)}/ptr`, { method: 'PUT', body: { ptr } });
      toast.success(t('saved')); setEditing(null); client.invalidateQueries({ queryKey: ['servers', server.id, 'ips'] });
    } catch (e) { setFieldError((e as { fields?: Record<string, string> }).fields?.ptr); toast.danger(error(e)); } finally { setBusy(false); }
  }
  const canEdit = rdns.enabled && rdns.customerEdit && server.state !== 'deleting';
  return <Section title={t('title')} description={rdns.enabled ? (rdns.customerEdit ? (rdns.forwardCheck ? t('helpForward') : t('help')) : t('helpLocked')) : t('helpNoRdns')}>
    <ul className="flex flex-col divide-y divide-separator">
      {addresses.map((a) => <li key={a.address} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Mono>{a.address}</Mono>
          <StatusChip tone={a.kind === 'primary' ? 'accent' : 'default'}>{t(`kind.${a.kind}`)}</StatusChip>
          {editing !== a.address && <span className="min-w-0 truncate text-sm text-muted">PTR: {a.ptr ? <Mono>{a.ptr.replace(/\.$/, '')}</Mono> : '–'}</span>}
        </div>
        {editing === a.address
          ? <div className="flex flex-wrap items-start gap-2">
              <TextInput className="min-w-64" label={t('ptr')} value={value} onChange={setValue} error={field(fieldError)} placeholder="mail.example.com" spellCheck={false}/>
              <Button className="mt-6" size="sm" isPending={busy} onPress={() => save(a.address, value)}>{t('save')}</Button>
              <Button className="mt-6" size="sm" variant="ghost" isDisabled={busy} onPress={() => save(a.address, '')}>{t('reset')}</Button>
              <Button className="mt-6" size="sm" variant="tertiary" onPress={() => setEditing(null)}>{t('cancel')}</Button>
            </div>
          : canEdit && <Button size="sm" variant="ghost" onPress={() => { setEditing(a.address); setValue(a.ptr?.replace(/\.$/, '') ?? ''); setFieldError(undefined); }}><I name="pencil" size={14}/>{t('edit')}</Button>}
      </li>)}
    </ul>
  </Section>;
}

function ServerFirewalls({ server }: { server: Server }) {
  const t = useTranslations('Firewalls');
  const { error } = useErrorText();
  const list = useApiQuery<{ firewalls: { id: string; name: string; rules: { direction: string }[] }[] }>(['firewalls', 'server', server.id], `/firewalls?serverId=${server.id}`).data?.firewalls;
  if (!list) return null;
  const tone = { applied: 'success', pending: 'accent', failed: 'danger' } as const;
  return <Section title={t('title')} description={list.length ? t('serverProtected') : t('serverOpen')}
    actions={<ButtonLink size="sm" variant="secondary" href="/firewalls"><I name="brick-wall-fire" size={14}/>{t('manage')}</ButtonLink>}>
    <div className="flex flex-col gap-3">
      {list.length > 0 && server.firewallStatus && <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusChip tone={tone[server.firewallStatus]}>{t(`status.${server.firewallStatus}`)}</StatusChip>
        {server.firewallStatus === 'failed' && server.firewallError && <span className="text-danger">{error({ code: server.firewallError })}</span>}
      </div>}
      {list.length === 0 ? <p className="text-sm text-muted">{t('serverNone')}</p>
        : <ul className="flex flex-wrap gap-2">{list.map((f) => <li key={f.id}>
          <NextLink href={`/firewalls/${f.id}`} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm hover:border-accent">
            <I name="shield-check" size={14}/>{f.name}<span className="text-xs text-muted">{t('ruleShort', { n: f.rules.length })}</span>
          </NextLink></li>)}</ul>}
    </div>
  </Section>;
}
