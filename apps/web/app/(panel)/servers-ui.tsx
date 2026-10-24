"use client";
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { apiFetch, useErrorText } from '../../lib/api';
import { Field, useApiForm } from '../../lib/form';

export type Server = { id: string; name: string; state: string; powerState: string; guestReady: boolean; vcpu: number; memoryMb: number; diskGb: number;
  priceMonthly: string; currency: string; errorCode: string | null; poolName: string; location: string; imageName: string; address: string | null;
  createdAt: string; ownerEmail?: string; lastOperation: { id: string; kind: string; status: string; step: string | null; errorCode: string | null } | null };
type Operation = { id: string; kind: string; status: string; step: string | null; attempts: number; errorCode: string | null; createdAt: string; finishedAt: string | null };

// One Idempotency-Key per user intention: a double click or a retry after a timeout reuses it,
// so the server never receives two different "create" requests for one click.
export function useIntentKey() {
  const ref = useRef<string>(undefined);
  return { key: () => (ref.current ??= crypto.randomUUID()), reset: () => { ref.current = undefined; } };
}

export function StateBadge({ server }: { server: Pick<Server, 'state' | 'powerState' | 'guestReady'> }) {
  const t = useTranslations('Servers');
  const cls = server.state === 'ready' && server.guestReady ? 'ok-text' : server.state === 'error' || server.state === 'missing' ? 'error' : 'muted';
  return <span className={cls}>{t(`state.${server.state as 'ready'}`)}{server.state === 'ready' && ` · ${t(`power.${server.powerState as 'poweredOn'}`)}`}
    {server.state === 'ready' && server.powerState === 'poweredOn' && !server.guestReady && ` · ${t('guestNotReady')}`}</span>;
}

export function SshKeys({ onChange }: { onChange?: (keys: { id: string; name: string }[]) => void }) {
  const t = useTranslations('Servers');
  const { error } = useErrorText();
  const [keys, setKeys] = useState<{ id: string; name: string; fingerprint: string }[]>([]);
  const f = useApiForm({ name: '', publicKey: '' });
  const load = () => apiFetch<{ keys: typeof keys }>('/ssh-keys').then((r) => { setKeys(r.keys); onChange?.(r.keys); }, () => undefined);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [message, setMessage] = useState<string>();
  return <article><h2>{t('keys.title')}</h2><p className="muted">{t('keys.explain')}</p>
    {message && <p aria-live="polite">{message}</p>}
    <ul>{keys.map((k) => <li key={k.id}>{k.name} <code className="muted">{k.fingerprint}</code>
      <button type="button" className="secondary small" onClick={() => apiFetch(`/ssh-keys/${k.id}`, { method: 'DELETE' }).then(load, (e) => setMessage(error(e)))}>{t('keys.remove')}</button></li>)}</ul>
    <form onSubmit={async (e) => { e.preventDefault(); if (await f.submit('POST', '/ssh-keys')) { f.setValues({ name: '', publicKey: '' }); load(); } }} noValidate>
      <Field id="key-name" label={t('keys.name')} error={f.fieldError('name')}><input id="key-name" value={f.values.name} onChange={f.set('name')}/></Field>
      <Field id="key-public" label={t('keys.publicKey')} help={t('keys.publicKeyHelp')} error={f.fieldError('publicKey')}>
        <input id="key-public" value={f.values.publicKey} onChange={f.set('publicKey')} spellCheck={false} placeholder="ssh-ed25519 AAAA… user@host"/></Field>
      <button type="submit" className="primary" disabled={f.busy}>{t('keys.add')}</button>
    </form></article>;
}

export function ServerList() {
  const t = useTranslations('Servers');
  const [servers, setServers] = useState<Server[]>();
  useEffect(() => {
    const load = () => apiFetch<{ servers: Server[] }>('/servers').then((r) => setServers(r.servers), () => undefined);
    load(); const timer = setInterval(load, 5000); return () => clearInterval(timer);
  }, []);
  return <article><h2>{t('list.title')}</h2>
    {servers?.length === 0 && <p className="muted">{t('list.empty')}</p>}
    {!!servers?.length && <table><thead><tr><th>{t('col.name')}</th><th>{t('col.state')}</th><th>IP</th><th>{t('col.size')}</th><th>{t('col.location')}</th></tr></thead>
      <tbody>{servers.map((s) => <tr key={s.id}><td><Link href={`/servers/${s.id}`}>{s.name}</Link></td><td><StateBadge server={s}/></td>
        <td>{s.address ?? '–'}</td><td>{t('size', { vcpu: s.vcpu, memory: s.memoryMb / 1024, disk: s.diskGb })}</td><td>{s.location || s.poolName}</td></tr>)}</tbody></table>}
  </article>;
}

const runningStates = ['pending', 'running'];

export function ServerDetail({ id }: { id: string }) {
  const t = useTranslations('Servers');
  const format = useFormatter();
  const { error } = useErrorText();
  const router = useRouter();
  const intent = useIntentKey();
  const [data, setData] = useState<{ server: Server; operations: Operation[] }>();
  const [message, setMessage] = useState<string>();
  const [confirm, setConfirm] = useState<{ action: string; text: string }>();
  const [deleteName, setDeleteName] = useState('');
  const load = () => apiFetch<{ server: Server; operations: Operation[] }>(`/servers/${id}`).then(setData, (e) => {
    if ((e as { code?: string }).code === 'NOT_FOUND') router.replace('/'); else setMessage(error(e));
  });
  useEffect(() => { load(); const timer = setInterval(load, 3000); return () => clearInterval(timer); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <p role="status">{message ?? t('loading')}</p>;
  const { server: s, operations } = data;
  const open = operations.find((o) => runningStates.includes(o.status));
  async function act(path: string, method: string, body?: object) {
    setMessage(undefined); setConfirm(undefined);
    try { await apiFetch(path, { method, body, headers: { 'idempotency-key': intent.key() } }); intent.reset(); load(); }
    catch (e) { setMessage(error(e)); if ((e as { code?: string }).code !== 'NETWORK') intent.reset(); }
  }
  const power = (action: string, dangerous = false) => <button type="button" className={dangerous ? 'danger-button' : 'secondary'} disabled={!!open || !['ready', 'error'].includes(s.state)}
    onClick={() => dangerous ? setConfirm({ action, text: t(`confirm.${action as 'power_off'}`) }) : act(`/servers/${id}/actions`, 'POST', { action })}>{t(`action.${action as 'power_on'}`)}</button>;

  return <>
    <header><p className="eyebrow">{s.location || s.poolName}</p><h1>{s.name}</h1><p><StateBadge server={s}/></p></header>
    {message && <p role="alert" className="error">{message}</p>}
    {s.errorCode && <p className="notice">{t('errorCode', { message: error({ code: s.errorCode }), code: s.errorCode })}</p>}
    <article><h2>{t('detail.overview')}</h2>
      <dl className="grid-dl">
        <dt>IP</dt><dd>{s.address ?? '–'}</dd>
        <dt>{t('col.size')}</dt><dd>{t('size', { vcpu: s.vcpu, memory: s.memoryMb / 1024, disk: s.diskGb })}</dd>
        <dt>{t('detail.image')}</dt><dd>{s.imageName}</dd>
        <dt>{t('detail.price')}</dt><dd>{format.number(Number(s.priceMonthly), { style: 'currency', currency: s.currency })}</dd>
        <dt>{t('detail.created')}</dt><dd>{format.dateTime(new Date(s.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</dd>
      </dl>
      <p className="muted">{t('readinessExplain')}</p>
    </article>
    {open && <article><h2>{t('detail.progress')}</h2>
      <p role="status">{t(`kind.${open.kind as 'create'}`)}: {t(`step.${(open.step ?? 'queued') as 'queued'}`)}{open.attempts > 1 && ` · ${t('attempt', { n: open.attempts })}`}</p>
      {open.kind === 'create' && <button type="button" className="secondary" onClick={() => act(`/servers/${id}/operations/${open.id}/cancel`, 'POST')}>{t('action.cancel')}</button>}
    </article>}
    <article><h2>{t('detail.power')}</h2><p className="muted">{t('powerExplain')}</p>
      <div className="actions">{power('power_on')}{power('shutdown')}{power('power_off', true)}{power('reset', true)}
        {s.state === 'ready' && <Link className="button" href={`/servers/${id}/console`}>{t('action.console')}</Link>}</div>
      {confirm && <div className="danger" role="alertdialog" aria-label={t(`action.${confirm.action as 'power_off'}`)}><p>{confirm.text}</p>
        <div className="actions"><button type="button" className="danger-button" onClick={() => act(`/servers/${id}/actions`, 'POST', { action: confirm.action })}>{t('confirm.yes', { action: t(`action.${confirm.action as 'power_off'}`) })}</button>
          <button type="button" className="secondary" onClick={() => setConfirm(undefined)}>{t('confirm.no')}</button></div></div>}
    </article>
    <article><h2>{t('detail.metrics')}</h2><p className="muted">{t('metricsEmpty')}</p></article>
    <article><h2>{t('detail.history')}</h2>
      <table><thead><tr><th>{t('col.when')}</th><th>{t('col.operation')}</th><th>{t('col.state')}</th><th>{t('col.detail')}</th></tr></thead>
        <tbody>{operations.map((o) => <tr key={o.id}><td>{format.dateTime(new Date(o.createdAt), { dateStyle: 'short', timeStyle: 'medium' })}</td><td>{t(`kind.${o.kind as 'create'}`)}</td>
          <td>{t(`opStatus.${o.status as 'pending'}`)}</td><td>{o.errorCode ? t('errorCode', { message: error({ code: o.errorCode }), code: o.errorCode }) : o.step ? t(`step.${o.step as 'queued'}`) : ''}</td></tr>)}</tbody></table></article>
    <section className="danger"><h2>{t('delete.title')}</h2><p>{t('delete.explain')}</p>
      <label htmlFor="delete-name">{t('delete.confirm', { name: s.name })}</label>
      <input id="delete-name" value={deleteName} onChange={(e) => setDeleteName(e.target.value)} autoComplete="off"/>
      <button type="button" className="danger-button" disabled={deleteName !== s.name || s.state === 'deleting'} onClick={() => act(`/servers/${id}`, 'DELETE', { confirm: deleteName })}>{t('delete.button')}</button>
    </section>
  </>;
}
