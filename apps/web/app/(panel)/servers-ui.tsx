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
import { ButtonLink, ConfirmButton, DataTable, Empty, Mono, Notice, PageHeader, Section, StatusChip, TextInput, type Tone } from '../../components/ui';

export type Server = { id: string; name: string; state: string; powerState: string; guestReady: boolean; vcpu: number; memoryMb: number; diskGb: number;
  priceMonthly: string; currency: string; errorCode: string | null; poolName: string; location: string; imageName: string; address: string | null;
  createdAt: string; ownerEmail?: string; firewallStatus?: 'applied' | 'pending' | 'failed'; firewallError?: string | null; firewallCount?: number; lastOperation: { id: string; kind: string; status: string; step: string | null; errorCode: string | null } | null };
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
    </div>
  </Section>;
}

export function ServerList() {
  const t = useTranslations('Servers');
  const tn = useTranslations('Nav');
  const servers = useApiQuery<{ servers: Server[] }>(['servers'], '/servers', { refetchInterval: 5_000 }).data?.servers;
  const [gridRef] = useAutoAnimate<HTMLUListElement>();
  if (!servers) return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy>{[0, 1, 2].map((i) => <Card key={i} className="h-36 animate-pulse"><span className="sr-only">…</span></Card>)}</div>;
  if (!servers.length) return <Empty icon={<I name="server" size={28}/>} title={t('list.empty')}><ButtonLink href="/order" className="mt-3"><I name="plus" size={16}/>{tn('newServer')}</ButtonLink></Empty>;
  return <ul ref={gridRef} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('list.title')}>
    {servers.map((s, i) => <motion.li key={s.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.05, duration: 0.25 }}>
      <NextLink href={`/servers/${s.id}`} className="block rounded-xl outline-offset-2 transition-all duration-200 hover:-translate-y-1 hover:shadow-lg focus-visible:outline-2">
        <Card className="h-full">
          <Card.Header className="flex flex-row items-start justify-between gap-2">
            <div className="min-w-0"><Card.Title className="truncate text-base font-semibold">{s.name}</Card.Title>
              <Card.Description className="flex items-center gap-1 text-xs text-muted"><I name="map-pin" size={12}/>{s.location || s.poolName}</Card.Description></div>
            <StateBadge server={s}/>
          </Card.Header>
          <Card.Content className="flex flex-col gap-1.5 text-sm">
            <span className="flex items-center gap-2"><span className="text-muted">IP</span>{s.address ? <Mono>{s.address}</Mono> : '–'}</span>
            <span className="flex items-center gap-2 text-muted"><I name="cpu" size={14}/>{size(t, s)}</span>
            <span className="truncate text-xs text-muted">{s.imageName}</span>
          </Card.Content>
        </Card>
      </NextLink>
    </motion.li>)}
  </ul>;
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
  const q = useApiQuery<{ server: Server; operations: Operation[] }>(['servers', id], `/servers/${id}`, { refetchInterval: 3_000 });
  const gone = (q.error as { code?: string } | null)?.code === 'NOT_FOUND';
  useEffect(() => { if (gone) router.replace('/'); }, [gone, router]);
  if (!q.data) return <p role="status" className="text-sm text-muted">{q.error && !gone ? error(q.error) : t('loading')}</p>;
  const { server: s, operations } = q.data;
  const open = operations.find((o) => runningStates.includes(o.status));
  // The same Idempotency-Key is kept until the server answers; only a network failure keeps it for a retry.
  async function act(path: string, method: string, body?: object) {
    setMessage(undefined);
    try { await apiFetch(path, { method, body, headers: { 'idempotency-key': intent.key() } }); intent.reset(); client.invalidateQueries({ queryKey: ['servers'] }); client.invalidateQueries({ queryKey: ['tasks'] }); }
    catch (e) { setMessage(error(e)); toast.danger(error(e)); if ((e as { code?: string }).code !== 'NETWORK') intent.reset(); }
  }
  const canAct = !open && ['ready', 'error'].includes(s.state);
  const actionLabel = (a: string) => t(`action.${a as 'power_on'}`);
  const power = (action: string, icon: React.ReactNode) => <Button variant="secondary" isDisabled={!canAct} onPress={() => act(`/servers/${id}/actions`, 'POST', { action })}>{icon}{actionLabel(action)}</Button>;
  const risky = (action: 'power_off' | 'reset', icon: React.ReactNode) => <ConfirmButton variant="danger-soft" isDisabled={!canAct} icon={icon} label={actionLabel(action)}
    title={actionLabel(action)} body={t(`confirm.${action}`)} confirmLabel={t('confirm.yes', { action: actionLabel(action) })} cancelLabel={t('confirm.no')}
    onConfirm={() => act(`/servers/${id}/actions`, 'POST', { action })}/>;

  return <div className="flex flex-col gap-6">
    <PageHeader eyebrow={s.location || s.poolName} title={s.name} description={<span className="mt-2 inline-flex"><StateBadge server={s}/></span>}
      actions={s.state === 'ready' && <ButtonLink variant="secondary" href={`/servers/${id}/console`}><I name="square-terminal" size={16}/>{actionLabel('console')}</ButtonLink>}/>
    {message && <div role="alert"><Notice tone="danger">{message}</Notice></div>}
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
          <div><dt className="text-muted">{t('detail.image')}</dt><dd className="mt-0.5">{s.imageName}</dd></div>
          <div><dt className="text-muted">{t('detail.price')}</dt><dd className="mt-0.5">{format.number(Number(s.priceMonthly), { style: 'currency', currency: s.currency })}</dd></div>
          <div><dt className="text-muted">{t('detail.created')}</dt><dd className="mt-0.5">{format.dateTime(new Date(s.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>
        </dl>
        <p className="mt-4 text-xs text-muted">{t('readinessExplain')}</p>
      </Section>
      <Section title={t('detail.power')} description={t('powerExplain')}>
        <div className="flex flex-wrap gap-2">
          {power('power_on', <I name="play" size={16}/>)}
          {power('shutdown', <I name="power" size={16}/>)}
          {risky('power_off', <I name="square" size={16}/>)}
          {risky('reset', <I name="rotate-ccw" size={16}/>)}
        </div>
      </Section>
    </div>

    <ServerFirewalls server={s}/>

    <ServerMetrics id={id} live={s.state === 'ready' && s.powerState === 'poweredOn'}/>

    <Section title={t('detail.history')}>
      <DataTable label={t('detail.history')} rows={operations} rowKey={(o) => o.id}
        columns={[{ id: 'when', label: t('col.when') }, { id: 'op', label: t('col.operation') }, { id: 'state', label: t('col.state') }, { id: 'detail', label: t('col.detail') }]}
        cells={(o) => [format.dateTime(new Date(o.createdAt), { dateStyle: 'short', timeStyle: 'medium' }), t(`kind.${o.kind as 'create'}`),
          <StatusChip key="s" tone={o.status === 'succeeded' ? 'success' : o.status === 'failed' ? 'danger' : o.status === 'cancelled' ? 'default' : 'accent'}>{t(`opStatus.${o.status as 'pending'}`)}</StatusChip>,
          o.errorCode ? t('errorCode', { message: error({ code: o.errorCode }), code: o.errorCode }) : o.step ? t(`step.${o.step as 'queued'}`) : '']}/>
    </Section>

    <Section title={t('delete.title')} description={t('delete.explain')} className="border border-danger/30">
      <div className="flex flex-wrap items-end gap-3">
        <TextInput className="min-w-64 flex-1" label={t('delete.confirm', { name: s.name })} value={deleteName} onChange={setDeleteName} autoComplete="off"/>
        <Button variant="danger" isDisabled={deleteName !== s.name || s.state === 'deleting'} onPress={() => act(`/servers/${id}`, 'DELETE', { confirm: deleteName })}>
          <I name="trash-2" size={16}/>{t('delete.button')}</Button>
      </div>
    </Section>
  </div>;
}

// The firewalls protecting this server and whether VMware has their current rules.
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
