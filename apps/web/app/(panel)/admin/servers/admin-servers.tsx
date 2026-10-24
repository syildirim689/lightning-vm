"use client";
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { StateBadge, type Server } from '../../servers-ui';

type Operation = { id: string; kind: string; status: string; step: string | null; attempts: number; errorCode: string | null; errorDetail: string | null;
  createdAt: string; serverName: string | null; serverId: string | null; ownerEmail: string | null };
type Finding = { id: number; kind: string; serverId: string | null; serverName: string | null; vmMoref: string | null; detail: Record<string, string>; lastSeen: string; connectionName: string };

export default function AdminServers() {
  const t = useTranslations('Servers');
  const format = useFormatter();
  const { error } = useErrorText();
  const [servers, setServers] = useState<Server[]>([]);
  const [ops, setOps] = useState<Operation[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [message, setMessage] = useState<string>();
  const load = () => Promise.all([apiFetch<{ servers: Server[] }>('/admin/servers'), apiFetch<{ operations: Operation[] }>('/admin/operations'),
    apiFetch<{ findings: Finding[] }>('/admin/reconciliation')]).then(([s, o, f]) => { setServers(s.servers); setOps(o.operations); setFindings(f.findings); }, (e) => setMessage(error(e)));
  useEffect(() => { load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const post = (path: string, done: string) => apiFetch(path, { method: 'POST' }).then(() => { setMessage(done); load(); }, (e) => setMessage(error(e)));
  return <>
    {message && <p aria-live="polite">{message}</p>}
    <article><h2>{t('admin.servers')}</h2>
      <table><thead><tr><th>{t('col.name')}</th><th>{t('admin.owner')}</th><th>{t('col.state')}</th><th>IP</th><th>{t('col.size')}</th><th>{t('col.location')}</th></tr></thead>
        <tbody>{servers.map((s) => <tr key={s.id}><td><Link href={`/servers/${s.id}`}>{s.name}</Link></td><td>{s.ownerEmail}</td><td><StateBadge server={s}/></td>
          <td>{s.address ?? '–'}</td><td>{t('size', { vcpu: s.vcpu, memory: s.memoryMb / 1024, disk: s.diskGb })}</td><td>{s.poolName}</td></tr>)}</tbody></table></article>
    <article><h2>{t('admin.operations')}</h2>
      <table><thead><tr><th>{t('col.when')}</th><th>{t('col.operation')}</th><th>{t('col.name')}</th><th>{t('col.state')}</th><th>{t('col.detail')}</th><th/></tr></thead>
        <tbody>{ops.map((o) => <tr key={o.id}><td>{format.dateTime(new Date(o.createdAt), { dateStyle: 'short', timeStyle: 'medium' })}</td><td>{t(`kind.${o.kind as 'create'}`)}</td>
          <td>{o.serverName ?? '–'}</td><td>{t(`opStatus.${o.status as 'pending'}`)}{o.attempts > 1 && ` · ${t('attempt', { n: o.attempts })}`}</td>
          <td>{o.errorCode ? t('errorCode', { message: error({ code: o.errorCode }), code: o.errorCode }) : o.step ? t(`step.${o.step as 'queued'}`) : ''}</td>
          <td>{o.status === 'failed' && <button type="button" className="secondary small" onClick={() => post(`/admin/operations/${o.id}/retry`, t('admin.retried'))}>{t('admin.retry')}</button>}</td></tr>)}</tbody></table></article>
    <article><h2>{t('admin.reconciliation')}</h2><p className="muted">{t('admin.reconcileExplain')}</p>
      <button type="button" className="secondary" onClick={() => post('/admin/reconcile', t('admin.reconcileQueued'))}>{t('admin.reconcile')}</button>
      {findings.length === 0 ? <p className="muted">{t('admin.noFindings')}</p> : <table><thead><tr><th>{t('col.when')}</th><th>{t('admin.finding')}</th><th>{t('col.name')}</th><th>{t('col.detail')}</th></tr></thead>
        <tbody>{findings.map((f) => <tr key={f.id}><td>{format.dateTime(new Date(f.lastSeen), { dateStyle: 'short', timeStyle: 'short' })}</td><td>{t(`finding.${f.kind as 'vm_missing'}`)}</td>
          <td>{f.serverName ?? f.detail.name ?? f.vmMoref}</td><td>{f.connectionName}{f.detail.actual ? ` · ${f.detail.recorded} → ${f.detail.actual}` : ''}</td></tr>)}</tbody></table>}
    </article>
  </>;
}
