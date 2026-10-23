"use client";
import { useRouter } from 'next/navigation';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, useErrorText, type ApiError } from '../../../lib/api';
import { setLocale } from '../../../i18n/actions';
import CredentialsForm from '../credentials-form';
import ConnectionForm from '../../(panel)/admin/vmware/connection-form';

type Check = { id: string; ok: boolean; code: string; detail?: Record<string, string | number> };
type Saved = { status: 'completed' | 'skipped'; data: Record<string, unknown> };
type Progress = { steps: Record<string, Saved>; adminCreated: boolean };

// Order matches the operator's journey; 'admin' and 'summary' are not stored as wizard steps.
const steps = ['language', 'checks', 'access', 'domain', 'services', 'admin', 'vmware', 'discovery', 'pools', 'monitoring', 'summary'] as const;
type Step = (typeof steps)[number];
const required: Step[] = ['language', 'checks', 'access', 'services', 'admin'];
const notYetAvailable: Step[] = ['pools'];

function CheckList({ checks }: { checks: Check[] }) {
  const t = useTranslations('Setup');
  const format = useFormatter();
  return <ul className="checks">{checks.map((c) => <li key={c.id} className={c.ok ? 'ok' : 'fail'}>
    <span aria-hidden>{c.ok ? '✓' : '✗'}</span> <strong>{t(`checkNames.${c.id}` as 'checkNames.postgres')}</strong>: {t(`checkCodes.${c.code}` as 'checkCodes.OK')}
    {c.detail?.version !== undefined && <span className="muted"> ({t('version', { version: String(c.detail.version) })})</span>}
    {c.detail?.a !== undefined && <span className="muted"> ({t('dnsDetail', { a: String(c.detail.a) || '–', aaaa: String(c.detail.aaaa) || '–' })})</span>}
    {c.detail?.issuer !== undefined && <span className="muted"> ({t('certDetail', { issuer: String(c.detail.issuer), validTo: c.detail.validTo ? format.dateTime(new Date(String(c.detail.validTo)), { dateStyle: 'medium' }) : '–' })})</span>}
  </li>)}</ul>;
}

export default function Wizard() {
  const t = useTranslations('Setup');
  const { error, field } = useErrorText();
  const router = useRouter();
  const locale = useLocale();
  const [progress, setProgress] = useState<Progress>();
  const [gate, setGate] = useState<'token' | 'login'>();
  const [current, setCurrent] = useState<Step>('language');
  const [checks, setChecks] = useState<Check[]>();
  const [failure, setFailure] = useState<ApiError & { text: string }>();
  const [busy, setBusy] = useState(false);
  const [publicUrl, setPublicUrl] = useState('');
  const [domain, setDomain] = useState('');
  const [monitoring, setMonitoring] = useState(false);

  const load = useCallback(async (jump = false) => {
    try {
      const p = await apiFetch<Progress>('/setup/progress');
      setProgress(p); setGate(undefined);
      const done = (s: Step) => s === 'admin' ? p.adminCreated : !!p.steps[s];
      if (jump) setCurrent(steps.find((s) => s !== 'summary' && !done(s)) ?? 'summary');
      setPublicUrl((p.steps.access?.data.publicUrl as string) ?? window.location.origin);
      setMonitoring(p.steps.monitoring?.data.enabled === true);
      // Suggest the host of the saved panel address when it is a name, not an IP or localhost.
      const host = p.steps.access?.data.publicUrl ? new URL(p.steps.access.data.publicUrl as string).hostname : '';
      setDomain((p.steps.domain?.data.domain as string) ?? (/[a-z]/.test(host.split('.').pop() ?? '') && host.includes('.') ? host : ''));
    } catch (e) {
      const code = (e as ApiError).code;
      if (code === 'BOOTSTRAP_REQUIRED') setGate('token');
      else if (code === 'UNAUTHENTICATED' || code === 'FORBIDDEN') setGate('login');
      else if (code === 'SETUP_CLOSED') router.replace('/admin');
      else setFailure({ code, text: error(e) });
    }
  }, [router]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(true); }, [load]);

  async function run<T>(action: () => Promise<T>, onOk?: (value: T) => void) {
    setBusy(true); setFailure(undefined);
    try { const value = await action(); onOk?.(value); return true; }
    catch (e) { setFailure({ ...(e as ApiError), text: error(e) }); return false; }
    finally { setBusy(false); }
  }
  const go = (step: Step) => { setCurrent(step); setChecks(undefined); setFailure(undefined); };
  const next = () => go(steps[Math.min(steps.indexOf(current) + 1, steps.length - 1)]);
  async function save(status: 'completed' | 'skipped', data?: object) {
    if (await run(() => apiFetch(`/setup/steps/${current}`, { method: 'PUT', body: { status, data } }))) { await load(); next(); }
  }

  if (gate === 'token') return <TokenGate onDone={() => load(true)}/>;
  if (gate === 'login') return <article><h1>{t('title')}</h1><p>{t('gate.adminExists')}</p><a className="button" href="/login">{t('gate.toLogin')}</a></article>;
  if (!progress) return <article><p role="status">{failure?.text ?? t('loading')}</p></article>;

  const index = steps.indexOf(current);
  const status = (s: Step) => s === 'admin' ? (progress.adminCreated ? 'completed' : undefined) : progress.steps[s]?.status;
  const isRequired = required.includes(current);
  const testButton = (path: string) => <button type="button" className="secondary" disabled={busy}
    onClick={() => run(() => apiFetch<{ checks: Check[] }>(path, { method: 'POST', body: current === 'access' ? { publicUrl } : current === 'domain' ? { domain } : undefined }), (r) => setChecks(r.checks))}>
    {busy ? t('testing') : t('test')}</button>;
  const saveButton = (data?: object) => <button type="button" className="primary" disabled={busy} onClick={() => save('completed', data)}>{t('saveAndContinue')}</button>;
  const skipButton = <button type="button" className="secondary" disabled={busy} onClick={() => save('skipped')}>{t('skip')}</button>;

  return <div className="wizard">
    <nav aria-label={t('title')} className="steps"><ol>{steps.map((s, i) => <li key={s}>
      <button type="button" aria-current={s === current ? 'step' : undefined} onClick={() => go(s)}>
        {i + 1}. {t(`steps.${s}.title`)} <span className="muted">{status(s) === 'completed' ? '✓' : status(s) === 'skipped' ? t('skippedShort') : ''}</span>
      </button></li>)}</ol></nav>
    <article>
      <p className="eyebrow">{t('stepOf', { n: index + 1, total: steps.length })} · {isRequired ? t('required') : t('optional')}</p>
      <h1>{t(`steps.${current}.title`)}</h1>
      <p>{t(`steps.${current}.help`)}</p>

      {current === 'language' && <form action={setLocale} className="lang-choice">
        {(['tr', 'en'] as const).map((l) => <button key={l} name="locale" value={l} aria-pressed={l === locale}>{l === 'tr' ? 'Türkçe' : 'English'}</button>)}
      </form>}
      {current === 'access' && <><label htmlFor="publicUrl">{t('access.label')}<span className="muted"> · {t('required')}</span></label>
        <input id="publicUrl" type="text" inputMode="url" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} aria-invalid={!!failure?.fields?.publicUrl} aria-describedby="publicUrl-help"/>
        <small id="publicUrl-help" className={failure?.fields?.publicUrl ? 'error' : 'muted'}>{field(failure?.fields?.publicUrl) ?? t('access.help')}</small></>}
      {current === 'admin' && (progress.adminCreated ? <p>{t('admin.done')}</p> : <CredentialsForm mode="setup" noToken onDone={() => load(true)}/>)}
      {current === 'domain' && <><label htmlFor="domain">{t('domain.label')}<span className="muted"> · {t('optional')}</span></label>
        <input id="domain" type="text" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="panel.example.com" aria-invalid={!!failure?.fields?.domain} aria-describedby="domain-help"/>
        <small id="domain-help" className={failure?.fields?.domain ? 'error' : 'muted'}>{field(failure?.fields?.domain) ?? t('domain.help')}</small>
        <ol className="howto">{(['dnsRecord', 'ports', 'apply', 'test'] as const).map((k) => <li key={k}>{t(`domain.howto.${k}`)}</li>)}</ol>
        <pre><code>{`sudo sh scripts/install.sh domain ${domain || 'panel.example.com'} --acme-staging\nsudo sh scripts/install.sh domain ${domain || 'panel.example.com'}`}</code></pre>
        <p className="muted">{t('domain.behindProxy')}</p></>}
      {current === 'vmware' && <><p className="muted">{t('vmware.note')}</p><ConnectionForm onSaved={() => save('completed')}/></>}
      {current === 'discovery' && <Discovered/>}
      {notYetAvailable.includes(current) && <p className="notice">{t(`notAvailable.${current as 'pools'}`)}</p>}
      {current === 'monitoring' && <><label className="check"><input type="checkbox" checked={monitoring} onChange={(e) => setMonitoring(e.target.checked)}/>{t('monitoring.enable')}</label>
        <p className="muted">{t('monitoring.help')}</p><pre><code>docker compose --profile observability up -d</code></pre></>}
      {current === 'summary' && <Summary progress={progress} status={status}/>}

      {checks && <CheckList checks={checks}/>}
      {current === 'access' && checks?.[0] && !checks[0].ok && <p className="muted">{t(`access.hint.${checks[0].code}` as 'access.hint.DNS_FAILED')}</p>}
      {current === 'domain' && checks?.filter((c) => !c.ok).map((c) => <p key={c.id} className="muted">{t(`domain.hint.${c.code}` as 'domain.hint.DNS_FAILED')}</p>)}
      {current === 'domain' && checks?.some((c) => c.id === 'dns' && c.detail?.aaaa) && <p className="muted">{t('domain.aaaaWarning')}</p>}
      {failure && <p role="alert" className="error">{failure.text}</p>}

      <div className="actions">
        {index > 0 && <button type="button" className="secondary" onClick={() => go(steps[index - 1])}>{t('back')}</button>}
        {current === 'language' && saveButton({ locale })}
        {current === 'checks' && <>{testButton('/setup/checks')}{saveButton()}</>}
        {current === 'access' && <>{testButton('/setup/test/access')}{saveButton({ publicUrl })}</>}
        {current === 'domain' && <>{testButton('/setup/test/domain')}{saveButton({ domain })}{skipButton}</>}
        {current === 'services' && <>{testButton('/setup/test/services')}{saveButton()}</>}
        {current === 'admin' && progress.adminCreated && <button type="button" className="primary" onClick={next}>{t('continue')}</button>}
        {current === 'vmware' && <>{saveButton()}{skipButton}</>}
        {current === 'discovery' && <>{saveButton()}{skipButton}</>}
        {notYetAvailable.includes(current) && skipButton}
        {current === 'monitoring' && <>{monitoring && testButton('/setup/test/monitoring')}{saveButton({ enabled: monitoring })}{skipButton}</>}
        {current === 'summary' && <button type="button" className="primary" disabled={busy}
          onClick={() => run(() => apiFetch('/setup/complete', { method: 'POST' }), () => { router.replace('/admin'); router.refresh(); })}>{t('finish')}</button>}
      </div>
    </article>
  </div>;
}

function Summary({ progress, status }: { progress: Progress; status: (s: Step) => string | undefined }) {
  const t = useTranslations('Setup');
  const access = progress.steps.access?.data;
  const warnings = [
    status('vmware') !== 'completed' && t('summary.warnVmware'),
    access && access.verified === false && t('summary.warnAccess'),
    status('domain') !== 'completed' && t('summary.warnHttps'),
  ].filter(Boolean) as string[];
  return <>
    <ul className="checks">{steps.filter((s) => s !== 'summary').map((s) => <li key={s} className={status(s) === 'completed' ? 'ok' : status(s) === 'skipped' ? '' : 'fail'}>
      <strong>{t(`steps.${s}.title`)}</strong>: {t(`summary.${status(s) ?? 'missing'}` as 'summary.missing')}{required.includes(s) && <span className="muted"> · {t('required')}</span>}
    </li>)}</ul>
    {access && <p>{t('summary.publicUrl', { url: String(access.publicUrl) })}</p>}
    {warnings.map((w) => <p key={w} className="notice">{w}</p>)}
  </>;
}

function TokenGate({ onDone }: { onDone: () => void }) {
  const t = useTranslations('Setup');
  const { error } = useErrorText();
  const [failure, setFailure] = useState<string>();
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setFailure(undefined);
    try { await apiFetch('/setup/session', { method: 'POST', body: { token: new FormData(e.currentTarget).get('token') } }); onDone(); }
    catch (err) { setFailure(error(err)); }
  }
  return <article><h1>{t('title')}</h1><p>{t('gate.text')}</p><pre><code>docker compose exec api node dist/cli.js bootstrap-token</code></pre>
    <form onSubmit={submit} noValidate>
      <label htmlFor="token">{t('gate.token')}<span className="muted"> · {t('required')}</span></label>
      <input id="token" name="token" type="password" autoComplete="one-time-code" spellCheck={false} aria-describedby="token-help"/>
      <small id="token-help" className="muted">{t('gate.tokenHelp')}</small>
      {failure && <p role="alert" className="error">{failure}</p>}
      <button type="submit" className="primary">{t('gate.submit')}</button>
    </form></article>;
}

// Summary of what the saved connections discovered; details live on the admin VMware page.
function Discovered() {
  const t = useTranslations('Setup');
  const { error } = useErrorText();
  const [rows, setRows] = useState<{ id: string; name: string; kind: string; hosts: number; vms: number }[]>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => { apiFetch<{ connections: typeof rows }>('/admin/vmware/connections').then((r) => setRows(r.connections), (e) => setFailure(error(e))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failure) return <p role="alert" className="error">{failure}</p>;
  if (!rows) return <p>{t('loading')}</p>;
  if (!rows.length) return <p className="notice">{t('discovery.none')}</p>;
  return <ul className="checks">{rows.map((c) => <li key={c.id} className={c.hosts ? 'ok' : 'fail'}>{t('discovery.row', { name: c.name, hosts: c.hosts, vms: c.vms })}</li>)}</ul>;
}
