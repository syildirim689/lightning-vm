"use client";
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';

type Certificate = { subject: string; issuer: string; notAfter: string; sha256: string; dnsNames: string[] | null; ips: string[] | null };
type Failure = ApiError & { text: string; certificate?: Certificate; conflicts?: { host: string; connection: string }[] };
export type Summary = { id?: string; product: { kind: string; fullName: string }; writeApi: string; operations: Record<string, boolean>; warnings: string[]; counts: Record<string, number> };

const fingerprintPairs = (hex: string) => hex.match(/../g)?.join(':').toUpperCase() ?? hex;

// Shared by the admin page and the setup wizard. Certificate trust is an explicit admin decision:
// an untrusted certificate is shown with its fingerprint and can be pinned, never ignored.
export default function ConnectionForm({ onSaved }: { onSaved: (s: Summary) => void }) {
  const t = useTranslations('Vmware');
  const { error, field } = useErrorText();
  const [form, setForm] = useState({ name: '', host: '', port: '443', username: '', password: '', mode: 'system', caPem: '', sha256: '' });
  const [failure, setFailure] = useState<Failure>();
  const [tested, setTested] = useState<Summary>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const body = () => ({ name: form.name, host: form.host, port: Number(form.port), username: form.username, password: form.password,
    tls: { mode: form.mode, ...(form.mode === 'ca' && { caPem: form.caPem }), ...(form.mode === 'pinned' && { sha256: form.sha256 }) } });

  async function run(path: string, onOk: (s: Summary) => void) {
    setBusy(true); setFailure(undefined); setTested(undefined);
    try { onOk(await apiFetch<Summary>(path, { method: 'POST', body: body() })); }
    catch (e) { setFailure({ ...(e as Failure), text: error(e) }); }
    finally { setBusy(false); }
  }

  const input = (k: keyof typeof form, type = 'text', required = true) => <>
    <label htmlFor={`vm-${k}`}>{t(`form.${k}` as 'form.name')}<span className="muted"> · {required ? t('required') : t('optional')}</span></label>
    <input id={`vm-${k}`} type={type} value={form[k]} onChange={set(k)} autoComplete={type === 'password' ? 'new-password' : 'off'} aria-invalid={!!failure?.fields?.[k]} aria-describedby={`vm-${k}-help`}/>
    <small id={`vm-${k}-help`} className={failure?.fields?.[k] ? 'error' : 'muted'}>{field(failure?.fields?.[k]) ?? t(`form.${k}Help` as 'form.nameHelp')}</small>
  </>;

  return <form onSubmit={(e) => { e.preventDefault(); run('/admin/vmware/connections', onSaved); }} noValidate>
    {input('name')}{input('host')}{input('port', 'text', false)}{input('username')}{input('password', 'password')}
    <label htmlFor="vm-mode">{t('form.tls')}</label>
    <select id="vm-mode" value={form.mode} onChange={set('mode')}>
      {(['system', 'ca', 'pinned'] as const).map((m) => <option key={m} value={m}>{t(`tlsMode.${m}`)}</option>)}
    </select>
    <small className="muted">{t('form.tlsHelp')}</small>
    {form.mode === 'ca' && <><label htmlFor="vm-caPem">{t('form.caPem')}</label><textarea id="vm-caPem" rows={6} value={form.caPem} onChange={set('caPem')} aria-invalid={!!failure?.fields?.caPem}/>
      <small className={failure?.fields?.caPem ? 'error' : 'muted'}>{field(failure?.fields?.caPem) ?? t('form.caPemHelp')}</small></>}
    {form.mode === 'pinned' && <><label htmlFor="vm-sha256">{t('form.sha256')}</label><input id="vm-sha256" value={form.sha256} onChange={set('sha256')} aria-invalid={!!failure?.fields?.sha256}/>
      <small className={failure?.fields?.sha256 ? 'error' : 'muted'}>{field(failure?.fields?.sha256) ?? t('form.sha256Help')}</small></>}

    {failure && <div role="alert" className="error"><p>{failure.text}</p>
      {failure.conflicts && <ul>{failure.conflicts.map((c) => <li key={c.host}>{t('conflict', { host: c.host, connection: c.connection })}</li>)}</ul>}</div>}
    {failure?.certificate && <article className="cert">
      <h3>{t('cert.title')}</h3><p className="muted">{t('cert.explain')}</p>
      <dl><dt>{t('cert.subject')}</dt><dd>{failure.certificate.subject}</dd><dt>{t('cert.issuer')}</dt><dd>{failure.certificate.issuer}</dd>
        <dt>{t('cert.notAfter')}</dt><dd>{failure.certificate.notAfter}</dd>
        <dt>{t('cert.names')}</dt><dd>{[...(failure.certificate.dnsNames ?? []), ...(failure.certificate.ips ?? [])].join(', ') || '–'}</dd>
        <dt>SHA-256</dt><dd><code>{fingerprintPairs(failure.certificate.sha256)}</code></dd></dl>
      <p className="muted">{t('cert.verify')}</p><pre><code>openssl x509 -in /etc/vmware/ssl/rui.crt -noout -fingerprint -sha256</code></pre>
      <button type="button" className="secondary" onClick={() => { setForm({ ...form, mode: 'pinned', sha256: failure.certificate!.sha256 }); setFailure(undefined); }}>{t('cert.pin')}</button>
    </article>}
    {tested && <p role="status" className="ok-text">{t('testOk', { kind: tested.product.fullName, hosts: tested.counts.hosts, vms: tested.counts.vms })}</p>}

    <div className="actions">
      <button type="button" className="secondary" disabled={busy} onClick={() => run('/admin/vmware/test', setTested)}>{busy ? t('working') : t('test')}</button>
      <button type="submit" className="primary" disabled={busy}>{t('save')}</button>
    </div>
  </form>;
}
