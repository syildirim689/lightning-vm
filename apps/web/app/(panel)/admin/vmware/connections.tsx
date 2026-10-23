"use client";
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, useErrorText } from '../../../../lib/api';
import ConnectionForm from './connection-form';

type Connection = { id: string; name: string; kind: string; host: string; port: number; tlsMode: string; writeApi: string; status: string;
  lastErrorCode: string | null; lastDiscoveredAt: string | null; hosts: number; vms: number; product: { fullName: string }; operations: Record<string, boolean>; warnings: string[] };
type Row = Record<string, string | number | boolean | null | string[]>;
type Detail = { connection: Connection; capacity: Record<string, number>; hosts: Row[]; datastores: Row[]; networks: Row[]; compute: Row[]; vms: Row[] };

export default function Connections() {
  const t = useTranslations('Vmware');
  const format = useFormatter();
  const { error } = useErrorText();
  const [list, setList] = useState<Connection[]>();
  const [detail, setDetail] = useState<Detail>();
  const [message, setMessage] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  const gb = (bytes: unknown) => format.number(Number(bytes) / 1024 ** 3, { maximumFractionDigits: 1 }) + ' GiB';
  const load = useCallback(() => apiFetch<{ connections: Connection[] }>('/admin/vmware/connections').then((r) => setList(r.connections), (e) => setMessage(error(e))), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const open = (id: string) => apiFetch<Detail>(`/admin/vmware/connections/${id}`).then((d) => { setDetail(d); setConfirmName(''); }, (e) => setMessage(error(e)));
  async function act(work: () => Promise<unknown>, done: string) {
    setMessage(undefined);
    try { await work(); setMessage(done); await load(); } catch (e) { setMessage(error(e)); }
  }

  if (!list) return <p role="status">{message ?? t('loading')}</p>;
  return <>
    {message && <p aria-live="polite">{message}</p>}
    {list.length === 0 && !adding && <p className="notice">{t('empty')}</p>}
    {list.length > 0 && <table><thead><tr><th>{t('col.name')}</th><th>{t('col.kind')}</th><th>{t('col.endpoint')}</th><th>{t('col.status')}</th><th>{t('col.hosts')}</th><th>{t('col.vms')}</th><th>{t('col.writeApi')}</th><th/></tr></thead>
      <tbody>{list.map((c) => <tr key={c.id}><td>{c.name}</td><td>{t(`kind.${c.kind as 'esxi'}`)}</td><td>{c.host}:{c.port}</td>
        <td className={c.status === 'ok' ? 'ok-text' : 'error'}>{c.status === 'ok' ? t('status.ok') : error({ code: c.lastErrorCode })}</td>
        <td>{c.hosts}</td><td>{c.vms}</td><td>{t(`writeApi.${c.writeApi as 'available'}`)}</td>
        <td><button type="button" className="secondary" onClick={() => open(c.id)}>{t('details')}</button></td></tr>)}</tbody></table>}
    {adding ? <article><h2>{t('addTitle')}</h2><ConnectionForm onSaved={() => { setAdding(false); act(async () => {}, t('saved')); }}/></article>
      : <button type="button" className="primary" onClick={() => setAdding(true)}>{t('add')}</button>}

    {detail && <article>
      <h2>{detail.connection.name} <span className="muted">· {detail.connection.product.fullName}</span></h2>
      {detail.connection.lastDiscoveredAt && <p className="muted">{t('lastDiscovered', { time: format.dateTime(new Date(detail.connection.lastDiscoveredAt), { dateStyle: 'medium', timeStyle: 'short' }) })}</p>}
      {detail.connection.warnings.map((w) => <p key={w} className="notice">{t(`warning.${w as 'HOST_MANAGED_BY_VCENTER'}`)}</p>)}
      {detail.connection.writeApi !== 'available' && <p className="notice">{t(`writeApiNote.${detail.connection.writeApi as 'restricted'}`)}</p>}
      <h3>{t('operationsTitle')}</h3>
      <ul className="checks">{Object.entries(detail.connection.operations).map(([op, ok]) => <li key={op} className={ok ? 'ok' : 'fail'}>{t(`operation.${op as 'inventory'}`)}: {ok ? t('yes') : t('no')}</li>)}</ul>
      <h3>{t('capacityTitle')}</h3><p className="muted">{t('capacityNote')}</p>
      <dl className="grid-dl">
        <dt>{t('cap.cpu')}</dt><dd>{t('cap.cpuValue', { cores: detail.capacity.cpuCores, threads: detail.capacity.cpuThreads, ghz: format.number(detail.capacity.cpuMhz / 1000, { maximumFractionDigits: 1 }) })}</dd>
        <dt>{t('cap.memory')}</dt><dd>{gb(detail.capacity.memoryBytes)}</dd>
        <dt>{t('cap.storage')}</dt><dd>{t('cap.storageValue', { capacity: gb(detail.capacity.storageCapacityBytes), free: gb(detail.capacity.storageFreeBytes), provisioned: gb(detail.capacity.storageProvisionedBytes) })}</dd>
      </dl>
      <h3>{t('hostsTitle')}</h3>
      <table><thead><tr><th>{t('col.name')}</th><th>{t('col.state')}</th><th>CPU</th><th>{t('cap.memory')}</th><th>{t('col.version')}</th></tr></thead>
        <tbody>{detail.hosts.map((h) => <tr key={String(h.moref)}><td>{h.name}</td><td>{h.connection_state} / {h.power_state}{h.in_maintenance ? ` · ${t('maintenance')}` : ''}</td>
          <td>{t('cap.cpuValue', { cores: Number(h.cpu_cores), threads: Number(h.cpu_threads), ghz: format.number(Number(h.cpu_mhz) / 1000, { maximumFractionDigits: 2 }) })}</td><td>{gb(h.memory_bytes)}</td><td>{h.version}</td></tr>)}</tbody></table>
      <h3>{t('datastoresTitle')}</h3>
      <table><thead><tr><th>{t('col.name')}</th><th>{t('col.type')}</th><th>{t('cap.capacity')}</th><th>{t('cap.free')}</th><th>{t('cap.uncommitted')}</th><th>{t('col.state')}</th></tr></thead>
        <tbody>{detail.datastores.map((d) => <tr key={String(d.moref)}><td>{d.name}</td><td>{d.type}</td><td>{gb(d.capacity_bytes)}</td><td>{gb(d.free_bytes)}</td><td>{gb(d.uncommitted_bytes)}</td><td>{d.accessible ? t('status.ok') : t('inaccessible')}</td></tr>)}</tbody></table>
      <h3>{t('networksTitle')}</h3>
      <table><thead><tr><th>{t('col.name')}</th><th>{t('col.type')}</th><th>VLAN</th><th>{t('col.switch')}</th></tr></thead>
        <tbody>{detail.networks.map((n) => <tr key={String(n.moref)}><td>{n.name}</td><td>{t(`networkKind.${n.kind as 'standard'}`)}</td><td>{n.vlan ?? '–'}</td><td>{n.switch ?? '–'}</td></tr>)}</tbody></table>
      <h3>{t('computeTitle')}</h3>
      <table><thead><tr><th>{t('col.name')}</th><th>{t('col.type')}</th><th>{t('col.hosts')}</th></tr></thead>
        <tbody>{detail.compute.map((c) => <tr key={String(c.moref)}><td>{c.name}</td><td>{t(`computeKind.${c.kind as 'cluster'}`)}</td><td>{c.hosts}</td></tr>)}</tbody></table>
      <h3>{t('vmsTitle', { count: detail.vms.length })}</h3>
      <table><thead><tr><th>{t('col.name')}</th><th>{t('col.power')}</th><th>vCPU</th><th>RAM</th><th>{t('col.guest')}</th><th/></tr></thead>
        <tbody>{detail.vms.map((v) => <tr key={String(v.moref)}><td>{v.name}{v.template ? ` (${t('template')})` : ''}</td><td>{v.power_state}</td><td>{v.cpu}</td><td>{format.number(Number(v.memory_mb) / 1024, { maximumFractionDigits: 1 })} GiB</td><td>{v.guest}</td>
          <td>{v.power_state === 'poweredOn' && !v.template && detail.connection.operations.console &&
            <a className="button" href={`/admin/vmware/console?c=${detail.connection.id}&vm=${encodeURIComponent(String(v.moref))}`}>{t('console')}</a>}</td></tr>)}</tbody></table>

      <div className="actions">
        <button type="button" className="secondary" onClick={() => act(() => apiFetch(`/admin/vmware/connections/${detail.connection.id}/discover`, { method: 'POST' }).then(() => open(detail.connection.id)), t('refreshed'))}>{t('refresh')}</button>
      </div>
      {/* Removing only forgets the connection here; the ESXi/vCenter and its VMs are not touched. */}
      <section className="danger"><h3>{t('remove.title')}</h3><p>{t('remove.explain')}</p>
        <label htmlFor="confirm-name">{t('remove.confirm', { name: detail.connection.name })}</label>
        <input id="confirm-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off"/>
        <button type="button" className="danger-button" disabled={confirmName !== detail.connection.name}
          onClick={() => act(() => apiFetch(`/admin/vmware/connections/${detail.connection.id}`, { method: 'DELETE' }).then(() => setDetail(undefined)), t('removed'))}>{t('remove.button')}</button>
      </section>
    </article>}
  </>;
}
