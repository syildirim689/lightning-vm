"use client";
import dynamic from 'next/dynamic';
import { Button, Card, Dropdown, Label, Modal, Popover, ProgressBar, toast } from '@heroui/react';
import { I } from '../../components/icon';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { usePercent } from '../../lib/percent';
import { memoryGb } from '../../lib/sizes';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { motion } from 'motion/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { apiFetch, useErrorText } from '../../lib/api';
import { useCopy } from '../../lib/clipboard';
import { supports, type Capabilities } from '../../components/capabilities';
import { useApiForm } from '../../lib/form';
import { useApiAction, useApiQuery } from '../../lib/query';
import { VmDetails } from './vm-details';
import { ServerIso } from './server-iso';
import { ServerHealth } from '../../components/smart';
import { ServerAnomalies } from '../../components/anomalies';
import { CloneServer, Copy, OrderSimilar, QuickConnect, RenameForm, RenameServer, ServerLabels } from './server-extras';
import { remember } from '../../lib/recent';
import { useDocTitle } from '../../lib/title';
import { PowerSchedules } from './server-schedules';
import { ServerUpdates } from './server-updates';
import { ServerSnapshots } from './server-snapshots';
import { ServerReinstall, ServerResize } from './server-change';
import { useBytes } from '../../lib/units';
import { latestFailure, nextStep } from '../../lib/next-step';
import { EtaLine, useSpoken } from '../../components/eta';
import { ETA_KINDS } from '../../lib/eta';
import { useUndoableRemove } from '../../components/undo';
// The charts (and their library) load with the server page's lower part, not with the server list.
const ServerMetrics = dynamic(() => import('./metrics'), { ssr: false });
const ServerTraffic = dynamic(() => import('./server-traffic').then((m) => m.ServerTraffic), { ssr: false });
import { ServerBackups } from './server-backups';
import { keyFingerprint, parseKey, snapshotName, sshKeyName } from '../../lib/proposals';
import { useProposal } from '../../lib/use-proposal';
import { ServerPlacement } from './server-placement';
import { ServerDisks } from './server-disks';
import { SaveAsImage } from './server-image';
import { TransferServer } from './server-transfer';
import { useMe } from '../../lib/me';
import { can, isStaff } from '../../lib/permissions';
import { noteLine } from '../../lib/note-line';
import { ServerFilters, ServerTotals, useServerFilters } from './server-filters';
import { flag } from '../../lib/flag';
import { Ago, ButtonLink, CheckboxInput, ConfirmButton, DataTable, Empty, LoadFailed, Mono, Notice, PageHeader, Section, StatusChip, TextInput, type Tone, Loading, returnFocus } from '../../components/ui';
import { useLatest } from '../../lib/latest';
import { SectionNav } from '../../components/section-nav';
import { ConnectCheck } from './connect-check';

export type Server = { id: string; name: string; state: string; powerState: string; guestReady: boolean; vcpu: number; memoryMb: number; diskGb: number;
  priceMonthly: string; currency: string; trafficGb?: number | null; trafficBytes?: number; billingMode?: 'monthly' | 'hourly'; priceHourly?: string | null; trafficThrottled?: boolean; errorCode: string | null; poolName: string; location: string; locationCity?: string | null; locationCountry?: string | null; locationDatacenter?: string | null; imageName: string; address: string | null;
  createdAt: string; platform?: string | null; capabilities?: Capabilities | null; favorite?: boolean; locked?: boolean; billingHold?: boolean; deleteAt?: string | null; tags?: string[]; notes?: string; poolId: string; imageId: string; packageId: string | null; vdcId?: string | null; projectId?: string | null; ownerEmail?: string; hasRootPassword?: boolean; applicationName?: string | null; appState?: 'pending' | 'installing' | 'installed' | 'failed' | null; appMessage?: string | null; firewallStatus?: 'applied' | 'pending' | 'failed'; firewallError?: string | null; firewallCount?: number; lastOperation: { id: string; kind: string; status: string; step: string | null; errorCode: string | null } | null };
const firewallFailed = (s: Server) => s.firewallStatus === 'failed';
// Something on this server is still changing (a task, an application install, firewall rules being applied).
export const moving = (s: Server) => ['pending', 'running'].includes(s.lastOperation?.status ?? '') || s.appState === 'pending' || s.appState === 'installing' || s.firewallStatus === 'pending';
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

const size = (t: ReturnType<typeof useTranslations<'Servers'>>, format: ReturnType<typeof useFormatter>, s: Pick<Server, 'vcpu' | 'memoryMb' | 'diskGb'>) => t('size', { vcpu: s.vcpu, memory: memoryGb(format, s.memoryMb), disk: s.diskGb });

export type SshKey = { id: string; name: string; fingerprint: string };
export const useSshKeys = () => useApiQuery<{ keys: SshKey[] }>(['ssh-keys'], '/ssh-keys').data?.keys ?? [];

export function SshKeys() {
  const t = useTranslations('Servers');
  const client = useQueryClient();
  const keysQ = useApiQuery<{ keys: SshKey[] }>(['ssh-keys'], '/ssh-keys');
  const keys = keysQ.data?.keys ?? [];
  const [listRef] = useAutoAnimate<HTMLUListElement>();
  const f = useApiForm({ name: '', publicKey: '' });
  // The key's own comment ("serhat@laptop"), else its type and fingerprint, as soon as a key is pasted.
  const pasted = parseKey(f.values.publicKey);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  useEffect(() => {
    let live = true; setFingerprint(null);
    if (pasted && !pasted.comment) keyFingerprint(pasted.blob).then((x) => { if (live) setFingerprint(x); }).catch(() => undefined);
    return () => { live = false; };
  }, [pasted?.blob, pasted?.comment]); // eslint-disable-line react-hooks/exhaustive-deps
  const proposal = keysQ.data ? sshKeyName(f.values.publicKey, fingerprint, keys.map((k) => k.name)) ?? '' : undefined;
  const { proposed, again } = useProposal(proposal, f.values.name, f.set('name'));
  const gh = useApiForm({ username: '' });
  // Removing a key changes nothing on servers that have it already (it is only left out of new orders): it waits a
  // few seconds behind Undo instead of asking first (components/undo.tsx).
  const tu = useTranslations('Undo');
  const { hidden, remove } = useUndoableRemove();
  const shown = keys.filter((k) => !hidden.has(`ssh-key:${k.id}`));
  return <Section title={t('keys.title')} description={t('keys.explain')}>
    <div className="flex flex-col gap-5">
      {shown.length > 0 && <ul ref={listRef} className="flex flex-col divide-y divide-separator rounded-lg border border-border">
        {shown.map((k) => <li key={k.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <I name="key-round" size={16} className="text-muted"/>
          <span className="font-medium">{k.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{k.fingerprint}</span>
          <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-9" aria-label={tu('removeNamed', { name: k.name })}
            onPress={() => remove({ id: `ssh-key:${k.id}`, text: tu('sshKey', { name: k.name }),
              commit: ({ keepalive }) => apiFetch(`/ssh-keys/${k.id}`, { method: 'DELETE', keepalive }), done: () => client.invalidateQueries({ queryKey: ['ssh-keys'] }) })}>
            <I name="trash-2" size={15}/>{t('keys.remove')}</Button>
        </li>)}
      </ul>}
      <form className="grid gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] md:items-start" noValidate
        onSubmit={async (e) => { e.preventDefault(); if (await f.submit('POST', '/ssh-keys')) { f.reset(); again(); client.invalidateQueries({ queryKey: ['ssh-keys'] }); toast.success(t('keys.added')); } }}>
        <TextInput maxLength={100} label={t('keys.name')} value={f.values.name} onChange={f.set('name')} error={f.fieldError('name')} proposed={proposed}/>
        <TextInput format="sshKey" label={t('keys.publicKey')} value={f.values.publicKey} onChange={f.set('publicKey')} error={f.fieldError('publicKey')} help={t('keys.publicKeyHelp')}
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
  const percent = usePercent();
  const t = useTranslations('Servers');
  const tn = useTranslations('Nav');
  const servers = useApiQuery<{ servers: Server[] }>(['servers'], '/servers', { refetchInterval: (d) => (d?.servers.some(moving) ? 5_000 : 20_000) }).data?.servers;
  const [gridRef] = useAutoAnimate<HTMLUListElement>();
  const f = useServerFilters(servers ?? []);
  const format = useFormatter();
  const bytes = useBytes();
  // What the server costs: per hour when billed hourly, else per month.
  const price = (s: Server) => s.billingMode === 'hourly' && s.priceHourly
    ? t('list.perHour', { price: format.number(Number(s.priceHourly), { style: 'currency', currency: s.currency, maximumFractionDigits: 4 }) })
    : Number(s.priceMonthly) > 0 ? t('list.perMonth', { price: format.number(Number(s.priceMonthly), { style: 'currency', currency: s.currency }) }) : null;
  // This month's traffic against the quota, when the server has one.
  const traffic = (s: Server) => { if (!s.trafficGb) return null; const used = s.trafficBytes ?? 0, pct = Math.min(100, Math.round((used / (s.trafficGb * 1024 ** 3)) * 100));
    return <span className="flex items-center gap-2 text-xs text-muted" title={t('list.traffic', { used: bytes(used), quota: `${s.trafficGb} GB` })}>
      <I name="arrow-down-up" size={12} className="shrink-0"/>
      <span role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('list.traffic', { used: bytes(used), quota: `${s.trafficGb} GB` })} className="h-1.5 w-20 overflow-hidden rounded-full bg-default">
        <span className={`block h-full rounded-full ${s.trafficThrottled || pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-success'}`} style={{ width: `${Math.max(pct, 2)}%` }}/></span>
      <span className="tabular-nums">{percent(pct)}</span></span>; };
  // Selection mode: cards toggle instead of opening, and a bar acts on the chosen ones (only those still shown).
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const anchor = useRef<string>(undefined);
  // Cards, or one compact row per server for long lists; remembered in this browser.
  const [view, setView] = useState<'cards' | 'rows'>('cards');
  useEffect(() => { try { if (localStorage.getItem('lvm-server-view') === 'rows') setView('rows'); } catch { /* storage blocked */ } }, []);
  const pickView = (v: 'cards' | 'rows') => { setView(v); try { localStorage.setItem('lvm-server-view', v); } catch { /* storage blocked */ } };
  const rows = view === 'rows';
  const stopPicking = () => { setPicking(false); setPicked(new Set()); };
  useEffect(() => {
    if (!picking) return;
    // Escape inside a popover or dialog closes only that, not the selection.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role=dialog],[role=alertdialog]:not([role=region] *)')) stopPicking(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking]);
  if (!servers) return <Loading of={['servers']}><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-busy>{[0, 1, 2].map((i) => <Card key={i} className="h-36 animate-pulse"><span className="sr-only">…</span></Card>)}</div></Loading>;
  if (!servers.length) return <Empty icon={<I name="server" size={28}/>} title={t('list.empty')}><ButtonLink href="/order" className="mt-3"><I name="plus" size={16}/>{tn('newServer')}</ButtonLink></Empty>;
  // Starred servers first, the rest in their order.
  const shown = [...f.shown].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite));
  const chosen = shown.filter((s) => picked.has(s.id));
  // Shift+click gives every card from the last clicked one to this one the state this one takes.
  const flip = (id: string, range: boolean) => {
    const from = shown.findIndex((x) => x.id === anchor.current), to = shown.findIndex((x) => x.id === id);
    setPicked((p) => {
      const n = new Set(p), on = !p.has(id);
      const ids = range && from >= 0 ? shown.slice(Math.min(from, to), Math.max(from, to) + 1).map((x) => x.id) : [id];
      ids.forEach((x) => (on ? n.add(x) : n.delete(x)));
      return n;
    });
    anchor.current = id;
  };
  return <div className="flex flex-col gap-4">
    {(servers.length > 1 || f.q || f.state !== 'all' || f.tag) && <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-3">
      <ServerFilters f={f} placeholder={t('list.searchPlaceholder')} manageTags/>
      {servers.length > 1 && <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={picking ? 'primary' : 'secondary'} aria-pressed={picking} onPress={() => (picking ? stopPicking() : setPicking(true))}>
          <I name={picking ? 'check' : 'list-checks'} size={15}/>{picking ? t('list.select.done') : t('list.select.start')}</Button>
        {picking && <Button size="sm" variant="ghost" onPress={() => setPicked(chosen.length === shown.length ? new Set() : new Set(shown.map((x) => x.id)))}>
          {chosen.length === shown.length ? t('list.select.none') : t('list.select.all')}</Button>}
        {picking && shown.length > 2 && <span className="hidden text-xs text-muted md:inline">{t('list.select.rangeHint')}</span>}
        <div role="group" aria-label={t('list.view.label')} className="ml-auto flex rounded-lg border border-border p-0.5">
          {(['cards', 'rows'] as const).map((v) => <button key={v} type="button" aria-pressed={view === v} title={t(`list.view.${v}`)} onClick={() => pickView(v)}
            className={`flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent ${view === v ? 'bg-accent-soft text-accent-soft-foreground' : 'text-muted hover:text-foreground'}`}>
            {v === 'cards' ? <I name="layout-grid" size={15}/> : <I name="rows-3" size={15}/>}<span className="hidden sm:inline">{t(`list.view.${v}`)}</span></button>)}
        </div>
      </div>}
    </div>}
    {!shown.length ? <div role="status" className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">{t('list.noMatch')}
      {f.filtered && <Button size="sm" variant="secondary" onPress={f.clear}><I name="funnel-x" size={15}/>{t('list.clearFilters')}</Button>}</div>
    : <ul ref={gridRef} className={rows ? 'flex flex-col gap-2' : 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'} aria-label={t('list.title')}>
    {shown.map((s, i) => { const on = picked.has(s.id); const card = rows ? <div data-row className={`flex h-full flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-border bg-surface py-3 pl-4 pr-32 text-sm transition-shadow ${on ? 'ring-2 ring-accent' : ''}`}>
          <span className="flex min-w-0 items-center gap-1.5 font-semibold sm:w-44"><span className="truncate">{s.name}</span>{s.locked && <I name="lock" size={13} className="shrink-0 text-warning"/>}</span>
          <StateBadge server={s}/>
          <span className="min-w-0 sm:w-32">{s.address ? <Mono>{s.address}</Mono> : <span className="text-muted">–</span>}</span>
          <span className="flex items-center gap-1.5 text-muted"><I name="cpu" size={14}/>{size(t, format, s)}</span>
          {price(s) && <span className="text-xs font-medium tabular-nums">{price(s)}</span>}
          <span className="flex items-center gap-1 text-xs text-muted"><I name="map-pin" size={12}/>{s.location || s.poolName}</span>
          {traffic(s)}
          {!!s.tags?.length && <span className="flex flex-wrap gap-1">{s.tags.map((x) => <span key={x} className="rounded-full bg-default px-2 py-0.5 text-xs">{x}</span>)}</span>}
          {firewallFailed(s) && <StatusChip tone="danger">{t('list.firewall.failed', { n: s.firewallCount ?? 0 })}</StatusChip>}
          {s.deleteAt && <StatusChip tone="danger">{t('trash.badge', { when: format.relativeTime(new Date(s.deleteAt), new Date()) })}</StatusChip>}
        </div> : <Card className={`h-full transition-shadow ${on ? 'ring-2 ring-accent' : ''}`}>
          <Card.Header className="flex flex-row items-start justify-between gap-2">
            <div className="min-w-0"><Card.Title className="flex items-center gap-1.5 truncate text-base font-semibold">{s.name}{s.locked && <I name="lock" size={13} className="shrink-0 text-warning"/>}</Card.Title>
              <Card.Description className="flex items-center gap-1 text-xs text-muted"><I name="map-pin" size={12}/>{s.location || s.poolName}</Card.Description></div>
            <StateBadge server={s}/>
          </Card.Header>
          <Card.Content className="flex flex-col gap-1.5 text-sm">
            <span className="flex items-center gap-2"><span className="text-muted">IP</span>{s.address ? <Mono>{s.address}</Mono> : '–'}</span>
            <span className="flex items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-2 text-muted"><I name="cpu" size={14} className="shrink-0"/><span className="truncate">{size(t, format, s)}</span></span>
              {price(s) && <span className="shrink-0 text-xs font-semibold tabular-nums">{price(s)}</span>}</span>
            {traffic(s)}
            <span className="flex items-center justify-between gap-2 text-xs text-muted"><span className="truncate">{s.imageName}</span>
              {!!s.firewallCount && <span className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium ${s.firewallStatus === 'failed' ? 'bg-danger/10 text-danger' : s.firewallStatus === 'pending' ? 'bg-accent-soft text-accent' : 'bg-success/10 text-success'}`}>
                <I name={firewallFailed(s) ? 'shield-x' : 'shield-check'} size={12}/>{t(`list.firewall.${s.firewallStatus ?? 'applied'}`, { n: s.firewallCount })}</span>}</span>
            {s.notes?.trim() && <span className="flex items-center gap-1.5 text-xs text-muted"><I name="sticky-note" size={13} className="shrink-0"/>
              <span className="sr-only">{t('list.note')}: </span><span className="truncate">{noteLine(s.notes, f.q)}</span></span>}
            {!!s.tags?.length && <span className="flex flex-wrap gap-1 pr-28 pt-1">{s.tags.map((x) => <span key={x} className="rounded-full bg-default px-2 py-0.5 text-xs">{x}</span>)}</span>}
            {s.deleteAt && <span className="pt-1"><StatusChip tone="danger">{t('trash.badge', { when: format.relativeTime(new Date(s.deleteAt), new Date()) })}</StatusChip></span>}
          </Card.Content>
        </Card>;
      return <motion.li key={s.id} className="relative" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.05, duration: 0.25 }}>
      {picking ? <button type="button" role="checkbox" aria-checked={on} aria-label={t('list.select.toggle', { name: s.name })} onClick={(e) => flip(s.id, e.shiftKey)}
          className="block h-full w-full rounded-xl text-left outline-offset-2 focus-visible:outline-2">
          {card}
          <span aria-hidden className={`absolute ${rows ? 'right-3 top-1/2 -translate-y-1/2' : 'bottom-3 right-3'} grid size-6 place-items-center rounded-md border-2 transition-colors ${on ? 'border-accent bg-accent text-accent-foreground' : 'border-border bg-surface'}`}>{on && <I name="check" size={14}/>}</span>
        </button>
      : <><NextLink href={`/servers/${s.id}`} className={`block h-full rounded-xl outline-offset-2 transition-all duration-200 hover:shadow-lg focus-visible:outline-2 ${rows ? 'hover:border-accent' : 'hover:-translate-y-1'}`}>{card}</NextLink>
        {s.address && <Copy text={s.address} label={`${s.name} IP`} className={`absolute ${rows ? 'right-12 top-1/2 -translate-y-1/2' : 'bottom-3 right-12'}`}/>}
        <QuickMenu s={s} className={`absolute ${rows ? 'right-[5.25rem] top-1/2 -translate-y-1/2' : 'bottom-3 right-[5.25rem]'}`}/>
        <FavoriteStar id={s.id} on={!!s.favorite} name={s.name} className={rows ? 'absolute right-3 top-1/2 -translate-y-1/2' : undefined}/></>}
    </motion.li>; })}
  </ul>}
  <ServerTotals servers={shown}/>
  {picking && chosen.length > 0 && <BulkBar servers={chosen} known={[...new Set(servers.flatMap((x) => x.tags ?? []))]} onDone={stopPicking}/>}
  </div>;
}

// The selection's actions, pinned near the bottom of the screen, above the task manager's button (safe-area aware on phones).
// Phones: fixed, since a sticky bar that wraps to several rows stops at the list's top and slides under that button;
// a spacer of its height keeps the last cards reachable.
function BulkBar({ servers, known, onDone }: { servers: Server[]; known: string[]; onDone: () => void }) {
  const t = useTranslations('Servers');
  const ids = servers.map((x) => x.id);
  const waiting = servers.filter((x) => x.deleteAt).length;
  const run = useApiAction(({ action, tag }: { action: string; tag?: string }) => apiFetch<{ started: number; skipped: number }>('/servers/actions', { method: 'POST', body: { action, serverIds: ids, tag }, headers: { 'idempotency-key': crypto.randomUUID() } }).then((r) => ({ ...r, tag })),
    { invalidate: [['servers'], ['tasks'], ['insights']], success: (r) => (r.tag ? t('list.select.tagDone', { n: r.started }) : t('list.select.bulkDone', { started: r.started, skipped: r.skipped })) });
  const act = (action: string) => run.mutateAsync({ action }).then(onDone, () => undefined);
  const label = (a: string) => t(`action.${a as 'power_on'}`);
  // Deleting several at once only goes through the admin's grace period (the API refuses it without one): the
  // confirmation names the hours, and without a grace period the button is not offered at all.
  const grace = useApiQuery<ServerPage>(['servers', ids[0]], ids[0] ? `/servers/${ids[0]}` : null).data?.deleteGraceHours;
  const copy = useCopy();
  const bar = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const o = new ResizeObserver(([e]) => setHeight(e.borderBoxSize?.[0]?.blockSize ?? e.target.getBoundingClientRect().height));
    if (bar.current) o.observe(bar.current);
    return () => o.disconnect();
  }, []);
  const confirm = (a: 'shutdown' | 'reset', icon: string) => <ConfirmButton size="sm" variant={a === 'reset' ? 'danger-soft' : 'secondary'} isDisabled={run.isPending} icon={<I name={icon} size={15}/>}
    label={label(a)} title={label(a)} body={t('list.select.confirm', { action: label(a), n: ids.length })} confirmLabel={t('confirm.yes', { action: label(a) })} cancelLabel={t('confirm.no')} onConfirm={() => act(a)}/>;
  return <><div aria-hidden className="md:hidden" style={{ height }}/>
  <motion.div ref={bar} role="region" aria-label={t('list.select.bar')} initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }}
    className="fixed inset-x-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-2xl border border-border bg-overlay/95 p-3 shadow-xl backdrop-blur md:sticky md:inset-x-auto md:w-full">
    <span role="status" className="mr-auto text-sm font-medium tabular-nums">{t('list.select.count', { n: ids.length })}</span>
    <Button size="sm" isPending={run.isPending} onPress={() => act('power_on')}><I name="play" size={15}/>{label('power_on')}</Button>
    {confirm('shutdown', 'power')}
    {confirm('reset', 'rotate-ccw')}
    {/* One address per line, ready for an inventory file or a hosts list. */}
    {servers.some((x) => x.address) && <Button size="sm" variant="secondary" onPress={() => {
      const ips = servers.flatMap((x) => x.address ? [x.address] : []);
      void copy(ips.join('\n'), t('list.select.ipsCopied', { n: ips.length }));
    }}><I name="copy" size={15}/>{t('list.select.copyIps')}</Button>}
    {/* Entries for ~/.ssh/config, so "ssh <name>" works; a Host alias cannot hold spaces. */}
    {servers.some((x) => x.address) && <Button size="sm" variant="secondary" onPress={() => {
      const hosts = servers.flatMap((x) => x.address ? [`Host ${x.name.trim().replace(/\s+/g, '-')}\n  HostName ${x.address}\n  User root`] : []);
      void copy(hosts.join('\n\n') + '\n', t('list.select.sshCopied', { n: hosts.length }));
    }}><I name="square-terminal" size={15}/>{t('list.select.copySsh')}</Button>}
    <BulkTags servers={servers} known={known} busy={run.isPending} onTag={(action, tag) => run.mutateAsync({ action, tag }).catch(() => undefined)}/>
    {waiting > 0 && <Button size="sm" variant="secondary" isPending={run.isPending} onPress={() => act('restore')}><I name="undo-2" size={15}/>{t('list.select.restore', { n: waiting })}</Button>}
    {waiting < servers.length && !!grace && grace > 0 && <ConfirmButton size="sm" variant="danger-soft" isDisabled={run.isPending} icon={<I name="trash-2" size={15}/>} label={t('list.select.delete')}
      title={t('list.select.delete')} body={t('list.select.deleteConfirm', { n: servers.length - waiting, hours: grace })} confirmLabel={t('list.select.delete')} cancelLabel={t('confirm.no')} onConfirm={() => act('delete')}/>}
    {waiting < servers.length && grace === 0 && <span className="text-xs text-muted">{t('list.select.deleteNoGrace')}</span>}
  </motion.div></>;
}

// Tags for the whole selection: the ones on any selected server can be taken off all of them; a new or known tag goes on all.
// A removed chip takes its focused button with it, so focus goes back to the field (Escape still closes the popover).
function BulkTags({ servers, known, busy, onTag }: { servers: Server[]; known: string[]; busy: boolean; onTag: (action: 'tag' | 'untag', tag: string) => Promise<unknown> }) {
  const t = useTranslations('Servers');
  const tx = useTranslations('Extras');
  const [draft, setDraft] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const on = [...new Set(servers.flatMap((x) => x.tags ?? []))];
  const everywhere = (tag: string) => servers.every((x) => x.tags?.includes(tag));
  const offer = known.filter((x) => !everywhere(x)).slice(0, 12);
  const add = (tag: string) => { if (tag.trim()) void onTag('tag', tag.trim()).then(() => setDraft('')); };
  return <Popover>
    <Button size="sm" variant="secondary"><I name="tag" size={15}/>{t('list.select.tags')}</Button>
    <Popover.Content placement="top" className="w-[20rem] max-w-[calc(100vw-1.5rem)]">
      <Popover.Dialog className="flex flex-col gap-3">
        <Popover.Heading className="text-sm font-semibold">{t('list.select.tagsTitle', { n: servers.length })}</Popover.Heading>
        <form ref={form} className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); add(draft); }}>
          <TextInput format="tag" className="flex-1" label={tx('addTag')} value={draft} onChange={setDraft} maxLength={24} placeholder={tx('tagPlaceholder')}/>
          <Button type="submit" size="sm" isPending={busy} isDisabled={!draft.trim()}><I name="plus" size={15}/>{tx('add')}</Button>
        </form>
        {offer.length > 0 && <div className="flex flex-col gap-1.5"><p className="text-xs text-muted">{t('list.select.tagsKnown')}</p>
          <ul className="flex flex-wrap gap-1.5">{offer.map((x) => <li key={x}><button type="button" disabled={busy} onClick={() => add(x)} aria-label={t('list.select.tagAdd', { tag: x })}
            className="flex min-h-8 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-xs hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"><I name="plus" size={12}/>{x}</button></li>)}</ul></div>}
        {on.length > 0 && <div className="flex flex-col gap-1.5"><p className="text-xs text-muted">{t('list.select.tagsOn')}</p>
          <ul className="flex flex-wrap gap-1.5">{on.map((x) => <li key={x} className="flex min-h-8 items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-xs text-accent-soft-foreground">
            {x}{!everywhere(x) && <span className="text-[10px] opacity-70">{t('list.select.tagSome')}</span>}
            <button type="button" disabled={busy} onClick={() => void onTag('untag', x).then(() => form.current?.querySelector('input')?.focus())} aria-label={t('list.select.tagRemove', { tag: x })}
              className="hit-44 grid size-6 place-items-center rounded-full hover:bg-accent/20 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"><I name="x" size={12}/></button></li>)}</ul></div>}
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}

// A card's quick menu, without opening the server: console, power on when off, the SSH command, a ticket about it,
// a new name, delete protection on or off, and deleting. Renaming and deleting open in a dialog with the server
// page's own form (deleting asks for the name there as it does here). Shutting down and forcing off stay on the page.
function QuickMenu({ s, className }: { s: Server; className: string }) {
  const t = useTranslations('Servers');
  const tx = useTranslations('Extras');
  const router = useRouter();
  const copy = useCopy();
  const lock = useServerLock(s.id, !!s.locked);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  // The menu item that opened a dialog is gone by the time it closes: focus goes back to the menu's button.
  const opener = useRef<HTMLButtonElement>(null);
  const closeDialog = () => { setDialog(null); returnFocus(opener.current); };
  const ready = s.state === 'ready' && !s.deleteAt;
  const start = useApiAction(() => apiFetch(`/servers/${s.id}/actions`, { method: 'POST', body: { action: 'power_on' }, headers: { 'idempotency-key': crypto.randomUUID() } }),
    { invalidate: [['servers'], ['tasks']], success: t('list.quick.started', { name: s.name }) });
  const run = async (k: React.Key) => {
    if (k === 'console') router.push(`/servers/${s.id}/console`);
    else if (k === 'power_on') start.mutate();
    else if (k === 'ssh' && s.address) await copy(`ssh root@${s.address}`, t('list.quick.sshCopied'));
    else if (k === 'ticket') router.push(`/support?new=1&server=${s.id}`);
    else if (k === 'rename' || k === 'delete') setDialog(k);
    else if (k === 'lock') void lock.flip();
  };
  return <><Dropdown>
    <Button ref={opener} isIconOnly size="sm" variant="ghost" aria-label={t('list.quick.label', { name: s.name })} className={`min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 ${className}`}><I name="ellipsis" size={17}/></Button>
    <Dropdown.Popover placement="bottom end">
      <Dropdown.Menu aria-label={t('list.quick.label', { name: s.name })} onAction={run}>
        {ready && supports(s, 'console') ? <Dropdown.Item id="console" textValue={t('action.console')}><I name="square-terminal" size={15}/><Label>{t('action.console')}</Label></Dropdown.Item> : null}
        {ready && s.powerState !== 'poweredOn' ? <Dropdown.Item id="power_on" textValue={t('action.power_on')}><I name="play" size={15}/><Label>{t('action.power_on')}</Label></Dropdown.Item> : null}
        {s.address ? <Dropdown.Item id="ssh" textValue={t('list.quick.ssh')}><I name="copy" size={15}/><Label>{t('list.quick.ssh')}</Label></Dropdown.Item> : null}
        <Dropdown.Item id="ticket" textValue={t('list.quick.ticket')}><I name="life-buoy" size={15}/><Label>{t('list.quick.ticket')}</Label></Dropdown.Item>
        {s.state !== 'deleting' ? <Dropdown.Item id="rename" textValue={tx('rename')}><I name="pencil" size={15}/><Label>{tx('rename')}</Label></Dropdown.Item> : null}
        <Dropdown.Item id="lock" textValue={t(s.locked ? 'list.quick.unlock' : 'list.quick.lock')}><I name={s.locked ? 'lock-open' : 'lock'} size={15}/><Label>{t(s.locked ? 'list.quick.unlock' : 'list.quick.lock')}</Label></Dropdown.Item>
        {!s.deleteAt && s.state !== 'deleting' ? <Dropdown.Item id="delete" textValue={t('list.quick.delete')} variant="danger"><I name="trash-2" size={15}/><Label>{t('list.quick.delete')}</Label></Dropdown.Item> : null}
      </Dropdown.Menu>
    </Dropdown.Popover>
  </Dropdown>
  {dialog === 'rename' && <QuickDialog title={t('list.quick.renameTitle', { name: s.name })} onClose={closeDialog}>
    <RenameForm server={s} autoFocus onClose={closeDialog}/>
  </QuickDialog>}
  {dialog === 'delete' && <QuickDialog title={t('list.quick.deleteTitle', { name: s.name })} onClose={closeDialog}><DeleteFromList id={s.id} onClose={closeDialog}/></QuickDialog>}
  </>;
}

// A small dialog for a quick-menu step that needs a form (Escape, the close button or a click outside leave it).
function QuickDialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <Modal.Backdrop isOpen onOpenChange={(o) => { if (!o) onClose(); }}>
    <Modal.Container scroll="inside">
      <Modal.Dialog className="bg-surface sm:max-w-[520px]">
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading className="pr-8 [overflow-wrap:anywhere]">{title}</Modal.Heading></Modal.Header>
        <Modal.Body className="pb-1">{children}</Modal.Body>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}

// Deleting from the list: the server page's own confirmation, with what that page knows (whether the admin lets
// customers delete, the grace period, the lock) asked from the same address the page reads.
function DeleteFromList({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations('Servers');
  const q = useApiQuery<ServerPage>(['servers', id], `/servers/${id}`);
  const { act, message } = useServerAct();
  if (!q.data) return q.error ? <LoadFailed error={q.error} retry={() => void q.refetch()}/>
    : <div role="status" aria-busy className="flex flex-col gap-3"><span className="sr-only">{t('loading')}</span>
        <span aria-hidden className="h-4 w-3/4 animate-pulse rounded bg-default motion-reduce:animate-none"/><span aria-hidden className="h-10 animate-pulse rounded-lg bg-default motion-reduce:animate-none"/></div>;
  const s = q.data.server;
  const grace = q.data.deleteGraceHours ?? 0;
  if (q.data.allowed?.delete === false) return <Notice tone="warning">{t('list.quick.deleteNotAllowed')}</Notice>;
  if (s.deleteAt) return <Notice tone="default">{t('trash.title')}</Notice>;
  return <div className="flex flex-col">
    <p className="mb-3 text-sm text-muted">{t('delete.explain')}</p>
    {message && <div role="alert" className="mb-3"><Notice tone="danger">{message}</Notice></div>}
    <DeleteServerForm server={s} grace={grace} canUnlock onDelete={async (body) => {
      if (!await act(`/servers/${id}`, 'DELETE', body)) return;
      toast.success(body.now ? t('list.quick.deleteStarted', { name: s.name }) : t('list.quick.deleteSoft', { name: s.name, hours: grace }));
      onClose();
    }}/>
  </div>;
}

type ServerPage = { server: Server; operations: Operation[]; own?: boolean; allowed?: Record<'power' | 'console' | 'iso' | 'rootPassword' | 'delete' | 'snapshots' | 'resize' | 'reinstall' | 'backups', boolean>; deleteGraceHours?: number };

// A request that changes a server, from its page or from the list. The same Idempotency-Key is kept until the
// server answers; only a network failure keeps it for a retry. False (with the reason shown) when it failed.
function useServerAct() {
  const { error } = useErrorText();
  const intent = useIntentKey();
  const client = useQueryClient();
  const [message, setMessage] = useState<string>();
  async function act(path: string, method: string, body?: object) {
    setMessage(undefined);
    try {
      await apiFetch(path, { method, body, headers: { 'idempotency-key': intent.key() } }); intent.reset();
      client.invalidateQueries({ queryKey: ['servers'] }); client.invalidateQueries({ queryKey: ['tasks'] });
      return true;
    } catch (e) { setMessage(error(e)); toast.danger(error(e)); if ((e as { code?: string }).code !== 'NETWORK') intent.reset(); return false; }
  }
  return { act, message };
}

// Deleting a server: its name typed out, the grace period (or "at once") and the lock that stands in the way.
// On the server's page and in the list's quick menu; the caller sends the request.
function DeleteServerForm({ server: s, grace, canUnlock, onDelete }: { server: Server; grace: number; canUnlock: boolean; onDelete: (body: { confirm: string; now: boolean }) => Promise<unknown> }) {
  const t = useTranslations('Servers');
  const [name, setName] = useState('');
  const [now, setNow] = useState(false);
  const [busy, setBusy] = useState(false);
  // Deleting waits out the admin's grace period for a ready server, unless the person chooses to delete at once.
  const soft = grace > 0 && s.state === 'ready';
  const locked = !!s.locked;
  return <>
    {soft && <p className="mb-3 flex items-start gap-2 text-sm text-muted"><I name="history" size={16} className="mt-0.5 shrink-0 text-accent"/>{t('delete.graceHelp', { hours: grace })}</p>}
    {/* Locked: why the button stays grey, with the unlock right here. */}
    {locked && <div className="mb-3"><LockBar id={s.id} locked canChange={canUnlock}/></div>}
    <div className="flex flex-wrap items-end gap-3">
      <TextInput transient className="min-w-0 flex-1 sm:min-w-64" label={t('delete.confirm', { name: s.name })} value={name} onChange={setName} autoComplete="off"/>
      <Button variant="danger" isPending={busy} isDisabled={name.trim() !== s.name || s.state === 'deleting' || locked}
        onPress={async () => { setBusy(true); try { await onDelete({ confirm: s.name, now: !soft || now }); } finally { setBusy(false); } }}>
        <I name="trash-2" size={16}/>{soft && !now ? t('delete.soft') : t('delete.button')}</Button>
    </div>
    {soft && <div className="mt-3"><CheckboxInput label={t('delete.now')} isSelected={now} onChange={setNow}/></div>}
  </>;
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

// A server waiting to be deleted: when, and the two ways out (take it back, or delete at once).
function TrashBar({ server: s, canChange }: { server: Server; canChange: boolean }) {
  const t = useTranslations('Servers');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const at = new Date(s.deleteAt!);
  const refresh = () => { void client.invalidateQueries({ queryKey: ['servers'] }); void client.invalidateQueries({ queryKey: ['tasks'] }); };
  async function restore() {
    setBusy(true);
    try { await apiFetch(`/servers/${s.id}/deletion`, { method: 'DELETE' }); toast.success(t('trash.restored')); refresh(); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  const deleteNow = async () => {
    try { await apiFetch(`/servers/${s.id}`, { method: 'DELETE', body: { confirm: s.name, now: true }, headers: { 'idempotency-key': crypto.randomUUID() } }); refresh(); }
    catch (e) { toast.danger(error(e)); throw e; }
  };
  return <motion.div role="status" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-3 rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3 sm:flex-row sm:items-center">
    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-danger/20 text-danger"><I name="trash-2" size={17}/></span>
    <div className="min-w-0 flex-1"><p className="text-sm font-medium">{t('trash.title')}</p>
      <p className="text-xs text-muted">{t('trash.body', { when: format.relativeTime(at, new Date()) })} <time dateTime={s.deleteAt!}>({format.dateTime(at, { dateStyle: 'medium', timeStyle: 'short' })})</time></p></div>
    {canChange && <div className="flex flex-wrap gap-2">
      <Button size="sm" isPending={busy} isDisabled={s.state === 'deleting'} onPress={restore}><I name="undo-2" size={14}/>{t('trash.restore')}</Button>
      <ConfirmButton size="sm" variant="danger-soft" isDisabled={s.state === 'deleting' || !!s.locked} icon={<I name="trash-2" size={14}/>} label={t('trash.now')} title={t('trash.now')}
        body={t('trash.nowConfirm')} confirmLabel={t('trash.now')} cancelLabel={t('confirm.no')} onConfirm={deleteNow}/>
    </div>}
  </motion.div>;
}

// Delete protection: a calm bar while unlocked, a clear warning-coloured one while locked.
function LockBar({ id, locked, canChange }: { id: string; locked: boolean; canChange: boolean }) {
  const t = useTranslations('Servers.lock');
  const { busy, flip } = useServerLock(id, locked);
  return <motion.div layout className={`flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 ${locked ? 'border-warning/40 bg-warning/10' : 'border-border bg-surface'}`}>
    <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${locked ? 'bg-warning/20 text-warning' : 'bg-default text-muted'}`}><I name={locked ? 'lock' : 'lock-open'} size={17}/></span>
    <div className="min-w-0 flex-1"><p className="text-sm font-medium">{locked ? t('onTitle') : t('offTitle')}</p><p className="text-xs text-muted">{locked ? t('onHelp') : t('offHelp')}</p></div>
    {canChange && <Button size="sm" variant={locked ? 'secondary' : 'ghost'} isPending={busy} onPress={flip}><I name={locked ? 'lock-open' : 'lock'} size={14}/>{locked ? t('unlock') : t('lock')}</Button>}
  </motion.div>;
}

// Turning delete protection on or off: the bar on the server's page and the list's quick menu send the same request.
function useServerLock(id: string, locked: boolean) {
  const t = useTranslations('Servers.lock');
  const { error } = useErrorText();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function flip() {
    setBusy(true);
    try { await apiFetch(`/servers/${id}/lock`, { method: 'PUT', body: { locked: !locked } }); toast.success(locked ? t('unlocked') : t('lockedNow')); void client.invalidateQueries({ queryKey: ['server', id] }); void client.invalidateQueries({ queryKey: ['servers'] }); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  return { busy, flip };
}

const runningStates = ['pending', 'running'];

// After a failed operation: what went wrong, what to do next and one button for it (lib/next-step). "Try again" is
// handed in by the page (its own button for that action, so the lock, the state and the permissions hold as they do
// there). The owner gets the links: the invoices, what the quota allows, or a ticket with the details filled in.
// Staff looking at a customer's server get the reason and, where it applies, the retry.
// Why something failed. A customer reads the sentence; the code that support will ask for stays on the element (shown
// on hover) and goes into the ticket the page writes. Staff read the code beside the sentence.
function Failure({ code, staff }: { code: string; staff: boolean }) {
  const t = useTranslations('Servers');
  const { error } = useErrorText();
  return staff ? <>{t('errorCode', { message: error({ code }), code })}</> : <span title={code} data-code={code}>{error({ code })}</span>;
}

function FailedNotice({ op, own, staff: showCode, retry, ticket }: { op: Operation; own: boolean; staff: boolean; retry: React.ReactNode; ticket: string }) {
  const t = useTranslations('Servers');
  const { error } = useErrorText();
  const next = nextStep(op.kind, op.errorCode);
  // Retry where the page does not offer the action (switched off for customers): support instead.
  const step = next.step === 'retry' && !retry ? 'support' : next.step;
  const staff = next.step === 'support' && next.staff;
  const link = (href: string, icon: string, label: string) => <ButtonLink size="sm" href={href}><I name={icon} size={14}/>{label}</ButtonLink>;
  const button = step === 'retry' ? retry : !own ? null
    : step === 'billing' ? link('/billing?show=open', 'wallet', t('nextStep.billingButton'))
    : step === 'quota' ? link('/order', 'gauge', t('nextStep.quotaButton'))
    : link(ticket, 'life-buoy', t('nextStep.supportButton'));
  return <Notice tone="danger" title={t('nextStep.title', { kind: t(`kind.${op.kind as 'create'}`) })}>
    <span className="flex flex-col items-start gap-2">
      <span><Failure code={op.errorCode ?? ''} staff={showCode}/> · <Ago at={op.finishedAt ?? op.createdAt}/></span>
      {(own || step === 'retry') && <span>{t(staff ? 'nextStep.staff' : `nextStep.${step}`)}</span>}
      {button}
    </span>
  </Notice>;
}

// How long the running operation has taken and how long such operations usually take here (components/eta.tsx),
// ticking every few seconds; the page already polls every 3 s while it runs.
function OperationTime({ op, diskGb }: { op: Operation; diskGb: number }) {
  const te = useTranslations('Eta');
  const say = useSpoken();
  const now = useNow({ updateInterval: 5_000 });
  const elapsed = Math.max(0, (now.getTime() - Date.parse(op.createdAt)) / 1000);
  return <p className="flex flex-col gap-0.5 text-sm">
    <span className="text-muted">{te('elapsed', { time: say(elapsed) })}</span>
    <EtaLine kind={op.kind} diskGb={diskGb} elapsed={elapsed} basis/>
  </p>;
}

// A long operation that just succeeded says so with the time it took (for two minutes), so the result is not only a
// changed badge. Power actions and the like are left out: they take seconds and the state shows them.
function JustFinished({ operations }: { operations: Operation[] }) {
  const t = useTranslations('Servers');
  const te = useTranslations('Eta');
  const say = useSpoken();
  const now = useNow({ updateInterval: 30_000 });
  const o = operations.find((x) => x.finishedAt);
  if (!o || o.status !== 'succeeded' || !(ETA_KINDS as readonly string[]).includes(o.kind) || now.getTime() - Date.parse(o.finishedAt!) > 120_000) return null;
  return <div role="status"><Notice tone="success">{te('finished', { kind: t(`kind.${o.kind as 'create'}`), time: say((Date.parse(o.finishedAt!) - Date.parse(o.createdAt)) / 1000) })}</Notice></div>;
}

export function ServerDetail({ id }: { id: string }) {
  const t = useTranslations('Servers');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { error } = useErrorText();
  const router = useRouter();
  const copy = useCopy();
  // Every change goes through one sender (one Idempotency-Key per intention, the reason shown when it fails).
  const change = useServerAct();
  const message = change.message;
  const act = (path: string, method: string, body?: object) => change.act(path, method, body).then(() => undefined);
  const page = useRef<HTMLDivElement>(null);
  const q = useApiQuery<ServerPage>(['servers', id], `/servers/${id}`, { refetchInterval: (d) => (!d || d.operations.some((o) => !o.finishedAt) || moving(d.server) ? 3_000 : 15_000) });
  const gone = (q.error as { code?: string } | null)?.code === 'NOT_FOUND';
  const me = useMe();
  // The viewer's own server names, for the next free name in "order similar".
  const mine = useApiQuery<{ servers: Server[] }>(['servers'], '/servers').data?.servers;
  const name = q.data?.server.name;
  useEffect(() => { if (name) remember({ href: `/servers/${id}`, label: name, kind: 'server' }); }, [name, id]);
  useDocTitle(name);
  useEffect(() => { if (gone) router.replace('/'); }, [gone, router]);
  if (!q.data) return <p role="status" className="text-sm text-muted">{q.error && !gone ? error(q.error) : t('loading')}</p>;
  const { server: s, operations } = q.data;
  // What the admin lets customers do here (missing: an older API, everything allowed).
  const allowed = { power: true, console: true, iso: true, rootPassword: true, delete: true, snapshots: true, resize: true, reinstall: true, backups: true, ...q.data.allowed };
  const open = operations.find((o) => runningStates.includes(o.status));
  const own = !!q.data.own; // owner-only helpers: tags and notes, order similar
  const seesCodes = !own || isStaff(me?.permissions); // error codes beside the sentences: staff, not customers
  const canAct = !open && ['ready', 'error'].includes(s.state);
  // Locked: what would end the server or lose its state waits until it is unlocked (the API refuses it too).
  const locked = !!s.locked;
  const actionLabel = (a: string) => t(`action.${a as 'power_on'}`);
  // A ready server's power state decides which buttons make sense; in an error state the power state may be stale, so all stay open.
  const on = s.state !== 'ready' || s.powerState !== 'poweredOff';
  const off = s.state !== 'ready' || s.powerState !== 'poweredOn';
  // `again`: the same button as "try again" in the failed-operation notice (same request, same conditions).
  const power = (action: string, icon: React.ReactNode, needs = true, again?: string) => <Button variant={again ? 'primary' : 'secondary'} size={again ? 'sm' : 'md'} isDisabled={!canAct || !needs}
    onPress={() => act(`/servers/${id}/actions`, 'POST', { action })}>{icon}{again ?? actionLabel(action)}</Button>;
  const risky = (action: 'power_off' | 'reset', icon: React.ReactNode, again?: string) => <ConfirmButton variant={again ? 'primary' : 'danger-soft'} size={again ? 'sm' : 'md'} isDisabled={!canAct || locked || !on} icon={icon} label={again ?? actionLabel(action)}
    title={actionLabel(action)} body={t(`confirm.${action}`)} confirmLabel={t('confirm.yes', { action: actionLabel(action) })} cancelLabel={t('confirm.no')}
    onConfirm={() => act(`/servers/${id}/actions`, 'POST', { action })}/>;
  // The newest operation, when it failed and still matters: what went wrong and the one thing to do next.
  const failure = open ? null : latestFailure(operations, s.state, now.getTime());
  // "Try again" is the page's own button for that action, or nothing where the page does not offer the action.
  const retry = (o: Operation) => {
    const label = t('nextStep.retryButton'), icon = <I name="rotate-cw" size={14}/>;
    if (o.kind === 'snapshot_create') return allowed.snapshots && ['ready', 'error'].includes(s.state)
      ? <Button size="sm" isDisabled={!canAct} onPress={() => act(`/servers/${id}/snapshots`, 'POST', { description: '', name: snapshotName(s.name) })}>{icon}{label}</Button> : null;
    if (!allowed.power) return null;
    return o.kind === 'power_on' ? power('power_on', icon, off, label) : o.kind === 'shutdown' ? power('shutdown', icon, on, label) : o.kind === 'reset' ? risky('reset', icon, label) : null;
  };
  // A ticket about a failed operation, with what support will ask for already written.
  const ticketHref = (o: Operation) => `/support?${new URLSearchParams({ new: '1', server: id,
    subject: t('failedTicket.subject', { kind: t(`kind.${o.kind as 'create'}`), name: s.name }),
    body: t('failedTicket.body', { kind: t(`kind.${o.kind as 'create'}`), when: format.dateTime(new Date(o.createdAt), { dateStyle: 'medium', timeStyle: 'medium' }), error: `${error({ code: o.errorCode ?? '' })} (${o.errorCode})`, op: o.id }) })}`;

  return <div ref={page} className="flex flex-col gap-6">
    <PageHeader eyebrow={s.location || s.poolName} title={s.name} description={<span className="mt-2 inline-flex"><StateBadge server={s}/></span>}
      actions={<>{s.state === 'ready' && allowed.console && supports(s, 'console') && <ButtonLink variant="secondary" href={`/servers/${id}/console`}><I name="square-terminal" size={16}/>{actionLabel('console')}</ButtonLink>}
        {own && <ButtonLink variant="ghost" href={`/support?new=1&server=${id}`}><I name="life-buoy" size={16}/>{t('getSupport')}</ButtonLink>}
        {own && <OrderSimilar server={s} names={(mine ?? []).map((x) => x.name)}/>}
        {own && <CloneServer server={s} names={(mine ?? []).map((x) => x.name)}/>}
        {(own || allowed.delete) && <RenameServer key={s.name} server={s}/>}</>}/>
    <SectionNav root={page} label={t('detail.sections')} top={t('detail.toTop')}
      lead={<span data-lead className="flex min-w-0 items-center gap-2 border-r border-separator pr-3"><span className="truncate text-sm font-semibold">{s.name}</span><span className="hidden shrink-0 md:inline-flex"><StateBadge server={s}/></span></span>}/>
    {message && <div role="alert"><Notice tone="danger">{message}</Notice></div>}
    {s.billingHold && <Notice tone="danger" title={t('billingHold')}>{t('billingHoldHelp')} <NextLink href="/billing?show=open" className="font-medium text-accent hover:underline">{t('payNow')}</NextLink></Notice>}
    {s.lastOperation?.step === 'awaiting_payment' && <Notice tone="warning" title={t('awaitingPayment')}>{t('awaitingPaymentHelp')} <NextLink href="/billing?show=open" className="font-medium text-accent hover:underline">{t('payNow')}</NextLink></Notice>}
    {s.deleteAt && <TrashBar server={s} canChange={allowed.delete}/>}
    <LockBar id={id} locked={locked} canChange={own || allowed.delete}/>
    {s.errorCode && s.errorCode !== failure?.errorCode && <Notice tone="danger"><Failure code={s.errorCode} staff={seesCodes}/></Notice>}
    {failure && <FailedNotice op={failure} own={own} staff={seesCodes} retry={retry(failure)} ticket={ticketHref(failure)}/>}
    {!open && !failure && <JustFinished operations={operations}/>}

    {open && <Section title={t('detail.progress')}>
      <div className="flex flex-col gap-3">
        <p role="status" className="text-sm">{t(`kind.${open.kind as 'create'}`)}: {t(`step.${(open.step ?? 'queued') as 'queued'}`)}{open.attempts > 1 && ` · ${t('attempt', { n: open.attempts })}`}</p>
        <ProgressBar aria-label={t('detail.progress')} isIndeterminate size="sm"><ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>
        <OperationTime op={open} diskGb={s.diskGb}/>
        {open.kind === 'create' && <div><Button size="sm" variant="secondary" onPress={() => act(`/servers/${id}/operations/${open.id}/cancel`, 'POST')}>{actionLabel('cancel')}</Button></div>}
      </div>
    </Section>}

    <div className="grid gap-6 lg:grid-cols-3">
      {/* "Copy summary": the facts in plain lines, for a ticket, a chat or a colleague. */}
      <Section title={t('detail.overview')} className="lg:col-span-2" actions={<Button size="sm" variant="ghost" onPress={async () => {
        const state = `${t(`state.${s.state as 'ready'}`)}${s.state === 'ready' ? ` · ${t(`power.${s.powerState as 'poweredOn'}`)}` : ''}`;
        const price = s.billingMode === 'hourly' && s.priceHourly ? t('detail.hourly', { price: format.number(Number(s.priceHourly), { style: 'currency', currency: s.currency, maximumFractionDigits: 4 }) })
          : format.number(Number(s.priceMonthly), { style: 'currency', currency: s.currency });
        const lines = [s.name, `IP: ${s.address ?? '–'}`, `${t('col.size')}: ${size(t, format, s)}`, `${t('detail.location')}: ${s.location || s.poolName}`, `${t('detail.image')}: ${s.imageName}`,
          `${t('col.state')}: ${state}`, `${t('detail.price')}: ${price}`, `${t('detail.created')}: ${format.dateTime(new Date(s.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}`];
        await copy(lines.join('\n'), t('detail.summaryCopied'));
      }}><I name="clipboard-copy" size={15}/>{t('detail.copySummary')}</Button>}>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted">IP</dt><dd className="mt-0.5">{s.address ? <Mono>{s.address}</Mono> : '–'}</dd></div>
          <div><dt className="text-muted">{t('col.size')}</dt><dd className="mt-0.5">{size(t, format, s)}</dd></div>
          <div><dt className="text-muted">{t('detail.location')}</dt><dd className="mt-0.5 flex flex-col">
            <span><span aria-hidden className="mr-1.5">{flag(s.locationCountry ?? '')}</span>{s.location || s.poolName}</span>
            {(s.locationCity || s.locationDatacenter) && <span className="text-xs text-muted">{[s.locationCity, s.locationDatacenter].filter(Boolean).join(' · ')}</span>}</dd></div>
          <div><dt className="text-muted">{t('detail.image')}</dt><dd className="mt-0.5">{s.imageName}</dd></div>
          <div><dt className="text-muted">{t('detail.price')}</dt><dd className="mt-0.5">{s.billingMode === 'hourly' && s.priceHourly
            ? t('detail.hourly', { price: format.number(Number(s.priceHourly), { style: 'currency', currency: s.currency, maximumFractionDigits: 4 }) })
            : format.number(Number(s.priceMonthly), { style: 'currency', currency: s.currency })}</dd></div>
          {s.applicationName && <div><dt className="text-muted">{t('detail.application')}</dt><dd className="mt-0.5 flex flex-wrap items-center gap-2">{s.applicationName}
            {s.appState && <StatusChip tone={s.appState === 'installed' ? 'success' : s.appState === 'failed' ? 'danger' : 'accent'}>{t(`appState.${s.appState}`)}</StatusChip>}
            {s.appState === 'failed' && s.appMessage && <span className="text-xs text-muted">{s.appMessage}</span>}</dd></div>}
          <div><dt className="text-muted">{t('detail.created')}</dt><dd className="mt-0.5">{format.dateTime(new Date(s.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
            <span className="ml-1.5 text-xs text-muted">(<Ago at={s.createdAt}/>)</span></dd></div>
        </dl>
        <p className="mt-4 text-xs text-muted">{t('readinessExplain')}</p>
      </Section>
      {allowed.power && <Section title={t('detail.power')} description={t('powerExplain')}>
        <div className="flex flex-wrap gap-2">
          {power('power_on', <I name="play" size={16}/>, off)}
          {power('shutdown', <I name="power" size={16}/>, on)}
          {risky('power_off', <I name="square" size={16}/>)}
          {risky('reset', <I name="rotate-ccw" size={16}/>)}
        </div>
        {/* Running but VMware Tools does not answer: a clean shutdown will not get through. */}
        {s.state === 'ready' && s.powerState === 'poweredOn' && !s.guestReady && <p className="mt-3 flex items-start gap-2 text-xs text-warning"><I name="info" size={14} className="mt-0.5 shrink-0"/>{t('shutdownNoTools')}</p>}
      </Section>}
    </div>

    <div className={`grid grid-cols-1 gap-6 ${s.address ? 'lg:grid-cols-2' : ''}`}><ServerHealth id={s.id} since={s.createdAt} measured={supports(s, 'metrics')}/><QuickConnect server={s}/></div>
    {s.state === 'ready' && <ServerAnomalies id={s.id}/>}
    {own && <ServerLabels key={`${s.tags?.join()}|${s.notes}`} server={s}/>}
    {own && (allowed.power || allowed.snapshots || allowed.backups) && s.state !== 'provisioning' && <PowerSchedules serverId={s.id} power={allowed.power} snapshots={allowed.snapshots} backups={allowed.backups}/>}
    {allowed.snapshots && ['ready', 'error'].includes(s.state) && <ServerSnapshots serverId={s.id} serverName={s.name} busy={!!open}/>}
    {allowed.backups && supports(s, 'backup') && ['ready', 'error'].includes(s.state) && <ServerBackups serverId={s.id} serverName={s.name} busy={!!open}/>}
    {['ready', 'error'].includes(s.state) && <ServerUpdates serverId={s.id} windows={/windows/i.test(s.imageName)} canChange={own || can(me?.permissions, 'servers.manage_all')} powered={s.powerState === 'poweredOn'}/>}
    <ServerIps server={s}/>
    {allowed.iso && supports(s, 'iso') && <ServerIso id={s.id} ready={s.state === 'ready' || s.state === 'error'}/>}
    {s.hasRootPassword && allowed.rootPassword && <RootPassword id={s.id}/>}
    <ConnectCheck server={s}/>
    <ServerFirewalls server={s}/>

    <ServerMetrics id={id} live={s.state === 'ready' && s.powerState === 'poweredOn'} since={s.createdAt} supported={supports(s, 'metrics')}/>
    <VmDetails id={id} hasVm={s.state === 'ready' || s.state === 'error'} platform={s.platform}/>
    {can(me?.permissions, 'servers.manage_all') && s.state === 'ready' && supports(s, 'migrate') && <ServerPlacement id={s.id} busy={!!open}/>}
    {s.state !== 'provisioning' && <ServerTraffic id={s.id} throttled={s.trafficThrottled} since={s.createdAt} supported={supports(s, 'metrics')}/>}
    {allowed.resize && s.state === 'ready' && !s.vdcId && <ServerResize server={s} busy={!!open}/>}
    {allowed.resize && s.state === 'ready' && !s.vdcId && <ServerDisks serverId={s.id} busy={!!open} windows={/windows/i.test(s.imageName)}/>}
    {own && ['ready', 'error'].includes(s.state) && <SaveAsImage serverId={s.id} serverName={s.name} busy={!!open} supported={supports(s, 'image')}/>}
    {allowed.reinstall && ['ready', 'error'].includes(s.state) && <ServerReinstall server={s} busy={!!open} own={own}/>}

    <Section title={t('detail.history')}>
      <DataTable label={t('detail.history')} rows={operations} rowKey={(o) => o.id}
        columns={[{ id: 'when', label: t('col.when') }, { id: 'op', label: t('col.operation') }, { id: 'state', label: t('col.state') }, { id: 'detail', label: t('col.detail') }]}
        cells={(o) => [<span key="w" className="flex flex-col">{format.dateTime(new Date(o.createdAt), { dateStyle: 'medium', timeStyle: 'medium' })}<span className="text-xs text-muted"><Ago at={o.createdAt}/></span></span>, t(`kind.${o.kind as 'create'}`),
          <StatusChip key="s" tone={o.status === 'succeeded' ? 'success' : o.status === 'failed' ? 'danger' : o.status === 'cancelled' ? 'default' : 'accent'}>{t(`opStatus.${o.status as 'pending'}`)}</StatusChip>,
          o.errorCode ? <span key="d" className="flex flex-col items-start gap-1"><Failure code={o.errorCode} staff={seesCodes}/>
            {own && o.status === 'failed' && (() => {
              // The row's link follows the same next step as the notice: the invoices, the quota, or a ticket.
              const step = nextStep(o.kind, o.errorCode).step;
              const [href, icon, label] = step === 'billing' ? ['/billing?show=open', 'wallet', t('nextStep.billingButton')] : step === 'quota' ? ['/order', 'gauge', t('nextStep.quotaButton')]
                : [ticketHref(o), 'life-buoy', t('failedTicket.link')];
              return <NextLink className="inline-flex min-h-6 items-center gap-1 rounded text-xs font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" href={href}><I name={icon} size={13}/>{label}</NextLink>;
            })()}</span>
          : o.step ? t(`step.${o.step as 'queued'}`) : '']}/>
    </Section>

    {(own || can(me?.permissions, 'servers.manage_all')) && s.state === 'ready' && !s.vdcId && <TransferServer serverId={s.id} serverName={s.name} staff={!own} busy={!!open}/>}
    {allowed.delete && !s.deleteAt && <Section title={t('delete.title')} description={t('delete.explain')} className="border border-danger/30">
      <DeleteServerForm server={s} grace={q.data.deleteGraceHours ?? 0} canUnlock={own || allowed.delete} onDelete={(body) => act(`/servers/${id}`, 'DELETE', body)}/>
    </Section>}
  </div>;
}

// The firewalls protecting this server and whether VMware has their current rules.
// The root password chosen (or generated) at order time: shown on request, and the panel's copy can be forgotten.
function RootPassword({ id }: { id: string }) {
  const t = useTranslations('Servers.password');
  const copy = useCopy();
  const { error } = useErrorText();
  const client = useQueryClient();
  const [shown, setShown] = useState<string>();
  async function reveal() {
    const isLatest = latest.begin();
    try { const { password } = await apiFetch<{ password: string }>(`/servers/${id}/root-password`); if (isLatest()) setShown(password); } catch (e) { if (isLatest()) toast.danger(error(e)); }
  }
  async function forget() {
  // A reveal still on its way when the password is forgotten (or hidden) must not show it afterwards.
  const latest = useLatest();
    try { await apiFetch(`/servers/${id}/root-password`, { method: 'DELETE' }); setShown(undefined); toast.success(t('forgotten')); client.invalidateQueries({ queryKey: ['servers', id] }); }
    catch (e) { toast.danger(error(e)); throw e; }
  }
  return <Section title={t('title')} description={t('help')}>
    latest.drop();
    <div className="flex flex-wrap items-center gap-2">
      {shown ? <><Mono>{shown}</Mono><Button size="sm" variant="ghost" onPress={() => void copy(shown, t('copied'))}><I name="copy" size={14}/>{t('copy')}</Button>
          <Button size="sm" variant="ghost" onPress={() => { latest.drop(); setShown(undefined); }}><I name="eye-off" size={14}/>{t('hide')}</Button></>
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
          <Copy text={a.address} label={a.address}/>
          {editing !== a.address && <span className="flex min-w-0 items-center gap-1 text-sm text-muted"><span className="min-w-0 truncate">PTR: {a.ptr ? <Mono>{a.ptr.replace(/\.$/, '')}</Mono> : '–'}</span>
            {a.ptr && <Copy text={a.ptr.replace(/\.$/, '')} label={t('ptrOf', { address: a.address })}/>}</span>}
        </div>
        {editing === a.address
          ? <form className="flex flex-wrap items-start gap-2" noValidate onSubmit={(e) => { e.preventDefault(); void save(a.address, value); }}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setEditing(null); } }}>
              <TextInput format="fqdn" className="min-w-64" label={t('ptr')} value={value} onChange={setValue} error={field(fieldError)} placeholder="mail.example.com" spellCheck={false}/>
              <Button type="submit" className="mt-6" size="sm" isPending={busy}>{t('save')}</Button>
              <Button className="mt-6" size="sm" variant="ghost" isDisabled={busy} onPress={() => save(a.address, '')}>{t('reset')}</Button>
              <Button className="mt-6" size="sm" variant="tertiary" onPress={() => setEditing(null)}>{t('cancel')}</Button>
            </form>
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
