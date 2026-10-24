"use client";
import { Button, Card, ProgressBar } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { I } from '../../../components/icon';
import { ButtonLink, CheckboxInput, Notice, StatusChip, TextInput } from '../../../components/ui';
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
  return <ul className="checks flex flex-col gap-2">{checks.map((c) => <li key={c.id} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${c.ok ? 'ok bg-success/10' : 'fail bg-danger/10'}`}>
    <I name={c.ok ? 'circle-check' : 'circle-x'} size={18} className={c.ok ? 'text-success' : 'text-danger'}/>
    <span><strong>{t(`checkNames.${c.id}` as 'checkNames.postgres')}</strong>: {t(`checkCodes.${c.code}` as 'checkCodes.OK')}
      {c.detail?.version !== undefined && <span className="text-muted"> ({t('version', { version: String(c.detail.version) })})</span>}
      {c.detail?.a !== undefined && <span className="text-muted"> ({t('dnsDetail', { a: String(c.detail.a) || '–', aaaa: String(c.detail.aaaa) || '–' })})</span>}
      {c.detail?.issuer !== undefined && <span className="text-muted"> ({t('certDetail', { issuer: String(c.detail.issuer), validTo: c.detail.validTo ? format.dateTime(new Date(String(c.detail.validTo)), { dateStyle: 'medium' }) : '–' })})</span>}</span>
  </li>)}</ul>;
}

export default function Wizard() {
  const t = useTranslations('Setup');
  const { error, field } = useErrorText();
  const router = useRouter();
  const locale = useLocale();
  const [, startLocale] = useTransition();
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
  const chooseLocale = (l: string) => startLocale(async () => { const f = new FormData(); f.set('locale', l); await setLocale(f); router.refresh(); });

  if (gate === 'token') return <TokenGate onDone={() => load(true)}/>;
  if (gate === 'login') return <Card className="mx-auto w-full max-w-md"><Card.Content className="flex flex-col gap-4">
    <h1 className="text-xl font-semibold">{t('title')}</h1><p className="text-sm text-muted">{t('gate.adminExists')}</p><ButtonLink href="/login">{t('gate.toLogin')}</ButtonLink>
  </Card.Content></Card>;
  if (!progress) return <p role="status" className="text-center text-sm text-muted">{failure?.text ?? t('loading')}</p>;

  const index = steps.indexOf(current);
  const status = (s: Step) => s === 'admin' ? (progress.adminCreated ? 'completed' : undefined) : progress.steps[s]?.status;
  const isRequired = required.includes(current);
  const doneCount = steps.filter((s) => status(s)).length;
  const testButton = (path: string) => <Button variant="secondary" isPending={busy}
    onPress={() => run(() => apiFetch<{ checks: Check[] }>(path, { method: 'POST', body: current === 'access' ? { publicUrl } : current === 'domain' ? { domain } : undefined }), (r) => setChecks(r.checks))}>
    {busy ? t('testing') : t('test')}</Button>;
  const saveButton = (data?: object) => <Button isDisabled={busy} onPress={() => save('completed', data)}>{t('saveAndContinue')}</Button>;
  const skipButton = <Button variant="ghost" isDisabled={busy} onPress={() => save('skipped')}>{t('skip')}</Button>;

  return <div className="wizard grid w-full max-w-6xl gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
    <Card className="self-start">
      <Card.Content className="flex flex-col gap-3">
        <ProgressBar aria-label={t('title')} value={doneCount} maxValue={steps.length - 1} size="sm"><ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>
        <nav aria-label={t('title')} className="steps"><ol className="flex flex-col gap-0.5">{steps.map((s, i) => <li key={s}>
          <button type="button" aria-current={s === current ? 'step' : undefined} onClick={() => go(s)}
            className={`flex w-full min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors duration-150 ${s === current ? 'bg-accent-soft font-medium text-accent-soft-foreground' : 'hover:bg-default'}`}>
            <span className={`grid size-6 shrink-0 place-items-center rounded-full text-xs ${status(s) === 'completed' ? 'bg-success text-success-foreground' : 'bg-default'}`}>
              {status(s) === 'completed' ? <I name="check" size={13}/> : i + 1}</span>
            <span className="flex-1">{t(`steps.${s}.title`)}</span>
            {status(s) === 'skipped' && <span className="text-xs text-muted">{t('skippedShort')}</span>}
          </button></li>)}</ol></nav>
      </Card.Content>
    </Card>
    <Card>
      <Card.Content className="flex flex-col gap-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">{t('stepOf', { n: index + 1, total: steps.length })} · {isRequired ? t('required') : t('optional')}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t(`steps.${current}.title`)}</h1>
          <p className="mt-1 text-sm text-muted">{t(`steps.${current}.help`)}</p>
        </div>

        {current === 'language' && <div className="flex gap-2">
          {(['tr', 'en'] as const).map((l) => <Button key={l} lang={l} variant={l === locale ? 'primary' : 'secondary'} aria-pressed={l === locale} onPress={() => chooseLocale(l)}>{l === 'tr' ? 'Türkçe' : 'English'}</Button>)}
        </div>}
        {current === 'access' && <TextInput label={t('access.label')} value={publicUrl} onChange={setPublicUrl} error={field(failure?.fields?.publicUrl)} help={t('access.help')} isRequired/>}
        {current === 'admin' && (progress.adminCreated ? <Notice tone="success">{t('admin.done')}</Notice> : <CredentialsForm mode="setup" noToken onDone={() => load(true)}/>)}
        {current === 'domain' && <div className="flex flex-col gap-4">
          <TextInput label={t('domain.label')} value={domain} onChange={setDomain} placeholder="panel.example.com" error={field(failure?.fields?.domain)} help={t('domain.help')}/>
          <ol className="howto flex list-decimal flex-col gap-1 pl-5 text-sm text-muted">{(['dnsRecord', 'ports', 'apply', 'test'] as const).map((k) => <li key={k}>{t(`domain.howto.${k}`)}</li>)}</ol>
          <pre className="overflow-x-auto rounded-lg bg-default p-3 font-mono text-xs">{`sudo sh scripts/install.sh domain ${domain || 'panel.example.com'} --acme-staging\nsudo sh scripts/install.sh domain ${domain || 'panel.example.com'}`}</pre>
          <p className="text-sm text-muted">{t('domain.behindProxy')}</p>
        </div>}
        {current === 'vmware' && <><p className="text-sm text-muted">{t('vmware.note')}</p><ConnectionForm onSaved={() => save('completed')}/></>}
        {current === 'discovery' && <Discovered/>}
        {notYetAvailable.includes(current) && <Notice tone="warning">{t(`notAvailable.${current as 'pools'}`)}</Notice>}
        {current === 'monitoring' && <div className="flex flex-col gap-3">
          <CheckboxInput label={t('monitoring.enable')} isSelected={monitoring} onChange={setMonitoring}/>
          <p className="text-sm text-muted">{t('monitoring.help')}</p><pre className="rounded-lg bg-default p-3 font-mono text-xs">docker compose --profile observability up -d</pre>
        </div>}
        {current === 'summary' && <Summary progress={progress} status={status}/>}

        {checks && <CheckList checks={checks}/>}
        {current === 'access' && checks?.[0] && !checks[0].ok && <p className="text-sm text-muted">{t(`access.hint.${checks[0].code}` as 'access.hint.DNS_FAILED')}</p>}
        {current === 'domain' && checks?.filter((c) => !c.ok).map((c) => <p key={c.id} className="text-sm text-muted">{t(`domain.hint.${c.code}` as 'domain.hint.DNS_FAILED')}</p>)}
        {current === 'domain' && checks?.some((c) => c.id === 'dns' && c.detail?.aaaa) && <p className="text-sm text-muted">{t('domain.aaaaWarning')}</p>}
        {failure && <div role="alert"><Notice tone="danger">{failure.text}</Notice></div>}

        <div className="flex flex-wrap items-center gap-2 border-t border-separator pt-4">
          {index > 0 && <Button variant="tertiary" onPress={() => go(steps[index - 1])}><I name="arrow-left" size={16}/>{t('back')}</Button>}
          <div className="ml-auto flex flex-wrap gap-2">
            {current === 'language' && saveButton({ locale })}
            {current === 'checks' && <>{testButton('/setup/checks')}{saveButton()}</>}
            {current === 'access' && <>{testButton('/setup/test/access')}{saveButton({ publicUrl })}</>}
            {current === 'domain' && <>{skipButton}{testButton('/setup/test/domain')}{saveButton({ domain })}</>}
            {current === 'services' && <>{testButton('/setup/test/services')}{saveButton()}</>}
            {current === 'admin' && progress.adminCreated && <Button onPress={next}>{t('continue')}</Button>}
            {current === 'vmware' && <>{skipButton}{saveButton()}</>}
            {current === 'discovery' && <>{skipButton}{saveButton()}</>}
            {notYetAvailable.includes(current) && skipButton}
            {current === 'monitoring' && <>{skipButton}{monitoring && testButton('/setup/test/monitoring')}{saveButton({ enabled: monitoring })}</>}
            {current === 'summary' && <Button isPending={busy} onPress={() => run(() => apiFetch('/setup/complete', { method: 'POST' }), () => { router.replace('/admin'); router.refresh(); })}>{t('finish')}</Button>}
          </div>
        </div>
      </Card.Content>
    </Card>
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
  return <div className="flex flex-col gap-3">
    <ul className="checks flex flex-col gap-1.5">{steps.filter((s) => s !== 'summary').map((s) => <li key={s} className={`flex items-center justify-between gap-2 rounded-lg bg-default/60 px-3 py-2 text-sm ${status(s) === 'completed' ? 'ok' : status(s) === 'skipped' ? '' : 'fail'}`}>
      <span><strong>{t(`steps.${s}.title`)}</strong>{required.includes(s) && <span className="text-muted"> · {t('required')}</span>}</span>
      <StatusChip tone={status(s) === 'completed' ? 'success' : status(s) === 'skipped' ? 'default' : 'danger'}>{t(`summary.${status(s) ?? 'missing'}` as 'summary.missing')}</StatusChip>
    </li>)}</ul>
    {access && <p className="text-sm">{t('summary.publicUrl', { url: String(access.publicUrl) })}</p>}
    {warnings.map((w) => <Notice key={w} tone="warning">{w}</Notice>)}
  </div>;
}

function TokenGate({ onDone }: { onDone: () => void }) {
  const t = useTranslations('Setup');
  const { error } = useErrorText();
  const [token, setToken] = useState('');
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setFailure(undefined); setBusy(true);
    try { await apiFetch('/setup/session', { method: 'POST', body: { token } }); onDone(); }
    catch (err) { setFailure(error(err)); } finally { setBusy(false); }
  }
  return <Card className="mx-auto w-full max-w-lg"><Card.Content className="flex flex-col gap-4">
    <h1 className="text-xl font-semibold">{t('title')}</h1><p className="text-sm text-muted">{t('gate.text')}</p>
    <pre className="overflow-x-auto rounded-lg bg-default p-3 font-mono text-xs">docker compose exec api node dist/cli.js bootstrap-token</pre>
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <TextInput label={t('gate.token')} type="password" value={token} onChange={setToken} autoComplete="one-time-code" spellCheck={false} help={t('gate.tokenHelp')} isRequired/>
      {failure && <p role="alert" className="text-sm text-danger">{failure}</p>}
      <Button type="submit" isPending={busy}>{t('gate.submit')}</Button>
    </form>
  </Card.Content></Card>;
}

// Summary of what the saved connections discovered; details live on the admin VMware page.
function Discovered() {
  const t = useTranslations('Setup');
  const { error } = useErrorText();
  const [rows, setRows] = useState<{ id: string; name: string; kind: string; hosts: number; vms: number }[]>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => { apiFetch<{ connections: typeof rows }>('/admin/vmware/connections').then((r) => setRows(r.connections), (e) => setFailure(error(e))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failure) return <p role="alert" className="text-sm text-danger">{failure}</p>;
  if (!rows) return <p className="text-sm text-muted">{t('loading')}</p>;
  if (!rows.length) return <Notice tone="warning">{t('discovery.none')}</Notice>;
  return <ul className="checks flex flex-col gap-2">{rows.map((c) => <li key={c.id} className={`rounded-lg px-3 py-2 text-sm ${c.hosts ? 'ok bg-success/10' : 'fail bg-danger/10'}`}>{t('discovery.row', { name: c.name, hosts: c.hosts, vms: c.vms })}</li>)}</ul>;
}
