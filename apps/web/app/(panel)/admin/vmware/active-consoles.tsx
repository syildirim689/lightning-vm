"use client";
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiFetch, useErrorText } from '../../../../lib/api';

type Session = { key: string; userId: string; email: string | null; vm: string; vmName: string; startedAt: string };

// Live consoles across all users; an admin can end any of them (the gateway closes it at once).
export default function ActiveConsoles() {
  const t = useTranslations('Console');
  const format = useFormatter();
  const { error } = useErrorText();
  const [sessions, setSessions] = useState<Session[]>();
  const [message, setMessage] = useState<string>();
  const load = () => apiFetch<{ sessions: Session[] }>('/admin/console/sessions').then((r) => setSessions(r.sessions), (e) => setMessage(error(e)));
  useEffect(() => { load(); const timer = setInterval(load, 10000); return () => clearInterval(timer); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function revoke(key: string) {
    try { await apiFetch(`/admin/console/sessions/${key}/revoke`, { method: 'POST' }); setMessage(t('revoked')); setTimeout(load, 500); }
    catch (e) { setMessage(error(e)); }
  }
  return <article><h2>{t('activeTitle')}</h2>
    {message && <p aria-live="polite">{message}</p>}
    {sessions?.length === 0 && <p className="muted">{t('activeEmpty')}</p>}
    {!!sessions?.length && <table><thead><tr><th>{t('col.user')}</th><th>{t('col.vm')}</th><th>{t('col.since')}</th><th/></tr></thead>
      <tbody>{sessions.map((s) => <tr key={s.key}><td>{s.email ?? s.userId}</td><td>{s.vmName || s.vm}</td>
        <td>{format.dateTime(new Date(s.startedAt), { timeStyle: 'short' })}</td>
        <td><button type="button" className="danger-button" onClick={() => revoke(s.key)}>{t('revoke')}</button></td></tr>)}</tbody></table>}
  </article>;
}
