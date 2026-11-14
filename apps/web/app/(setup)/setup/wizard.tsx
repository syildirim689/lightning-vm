"use client";
// First-run wizard. Each step shows one primary action for its state: steps with checks run them on arrival,
// "Continue" appears only after they pass, a changed field makes the result stale ("Check" again), a failure
// offers "Check again". The API repeats every check when a step is saved, so the browser is never trusted.
// Required steps must be done in order; optional ones can be skipped. Motion follows the user's "reduce motion"
// choice through the app's MotionConfig (movement is dropped, fades stay).
import { Button, Card, ProgressBar } from '@heroui/react';
import { motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { I } from '../../../components/icon';
import { ButtonLink, CheckboxInput, Notice, StatusChip, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../lib/api';
import { setLocale } from '../../../i18n/actions';
import CredentialsForm from '../../(auth)/credentials-form';
import ConnectionForm from '../../(panel)/admin/vmware/connection-form';

type Check = { id: string; ok: boolean; code: string; detail?: Record<string, string | number> };
type Saved = { status: 'completed' | 'skipped'; data: Record<string, unknown> };
type Progress = { steps: Record<string, Saved>; adminCreated: boolean };

// Order matches the operator's journey; 'admin' and 'summary' are not stored as wizard steps.
const steps = ['language', 'checks', 'access', 'domain', 'services', 'admin', 'vmware', 'discovery', 'pools', 'monitoring', 'summary'] as const;
type Step = (typeof steps)[number];
const required: Step[] = ['language', 'checks', 'access', 'services', 'admin'];
const notYetAvailable: Step[] = ['pools'];
const stepIcon: Record<Step, React.ReactNode> = {
  language: <I name="languages" size={18}/>, checks: <I name="list-checks" size={18}/>, access: <I name="globe" size={18}/>, domain: <I name="lock" size={18}/>,
  services: <I name="database" size={18}/>, admin: <I name="user-plus" size={18}/>, vmware: <I name="server" size={18}/>, discovery: <I name="radar" size={18}/>,
  pools: <I name="boxes" size={18}/>, monitoring: <I name="activity" size={18}/>, summary: <I name="flag" size={18}/>,
};

function CheckList({ checks }: { checks: Check[] }) {
  const t = useTranslations('Setup');
  const format = useFormatter();
  return <ul className="checks flex flex-col gap-2">{checks.map((c, i) => <motion.li key={c.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07, duration: 0.25, ease: 'easeOut' }}
    className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 text-sm ${c.ok ? 'ok border-success/30 bg-success/5' : c.code === 'STARTING' ? 'border-accent/30 bg-accent/5' : 'fail border-danger/30 bg-danger/5'}`}>
    {c.code === 'STARTING' ? <I name="loader-circle" size={18} className="mt-0.5 shrink-0 animate-spin text-accent motion-reduce:animate-none"/>
      : <I name={c.ok ? 'circle-check' : 'circle-x'} size={18} className={`mt-0.5 shrink-0 ${c.ok ? 'text-success' : 'text-danger'}`}/>}
    <span className="min-w-0"><strong>{t(`checkNames.${c.id}` as 'checkNames.postgres')}</strong>: {t(`checkCodes.${c.code}` as 'checkCodes.OK')}
      {c.detail?.version !== undefined && <span className="text-muted"> ({t('version', { version: String(c.detail.version) })})</span>}
      {c.detail?.a !== undefined && <span className="text-muted"> ({t('dnsDetail', { a: String(c.detail.a) || '–', aaaa: String(c.detail.aaaa) || '–' })})</span>}
      {c.detail?.issuer !== undefined && <span className="text-muted"> ({t('certDetail', { issuer: String(c.detail.issuer), validTo: c.detail.validTo ? format.dateTime(new Date(String(c.detail.validTo)), { dateStyle: 'medium' }) : '–' })})</span>}</span>
  </motion.li>)}</ul>;
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
  const [result, setResult] = useState<{ step: Step; key: string; checks: Check[] }>();
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<ApiError & { text: string }>();
  const [busy, setBusy] = useState(false);
  const [publicUrl, setPublicUrl] = useState('');
  const [domain, setDomain] = useState('');
  const [monitoring, setMonitoring] = useState(false);
  const [hosts, setHosts] = useState<number>();
  // Monitoring: running when the step opened, a start requested from the host agent, and how many checks since.
  const [monitorRunning, setMonitorRunning] = useState(false);
  const [starting, setStarting] = useState<'no' | 'requested' | 'failed'>('no');
  const [polls, setPolls] = useState(0);

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

  // What the current step checks, and the input the result belongs to (a changed input makes it stale).
  const probe = (): { path: string; body?: object; key: string } | null => {
    if (current === 'checks') return { path: '/setup/checks', key: '-' };
    if (current === 'services') return { path: '/setup/test/services', key: '-' };
    if (current === 'access') return { path: '/setup/test/access', body: { publicUrl }, key: publicUrl.trim() };
    if (current === 'domain') return domain.trim() ? { path: '/setup/test/domain', body: { domain }, key: domain.trim() } : null;
    if (current === 'monitoring') return monitoring ? { path: '/setup/test/monitoring', key: 'on' } : null;
    return null;
  };
  const p = probe();
  const fresh = !!p && result?.step === current && result.key === p.key;
  const passed = fresh && result!.checks.every((c) => c.ok);

  async function runChecks() {
    const pr = probe();
    if (!pr) return;
    setChecking(true); setFailure(undefined);
    try { const r = await apiFetch<{ checks: Check[] }>(pr.path, { method: 'POST', body: pr.body }); setResult({ step: current, key: pr.key, checks: r.checks }); }
    catch (e) { setResult(undefined); setFailure({ ...(e as ApiError), text: error(e) }); }
    finally { setChecking(false); }
  }
  // Checks that need no input run as soon as the step opens (and the monitoring check when it is switched on).
  useEffect(() => {
    if (progress && (current === 'checks' || current === 'services' || current === 'access' || (current === 'monitoring' && monitoring))) void runChecks();
  }, [current, progress?.adminCreated, monitoring]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (current !== 'monitoring' || !progress) return;
    setStarting('no'); setPolls(0);
    apiFetch<{ checks: Check[] }>('/setup/test/monitoring', { method: 'POST' }).then((r) => {
      // Installed when any component answers; the others may still be starting (Loki needs a minute).
      const up = r.checks.some((c) => c.ok);
      setMonitorRunning(up);
      if (up && !progress.steps.monitoring) setMonitoring(true);
    }, () => undefined);
  }, [current, !!progress]); // eslint-disable-line react-hooks/exhaustive-deps
  // Ticked but not answering: the panel starts the stack itself, then checks every 5 s for up to 3 minutes.
  useEffect(() => {
    if (current !== 'monitoring' || !monitoring || !fresh || passed || checking || starting === 'failed' || polls >= 36) return;
    if (starting === 'no') {
      setStarting('requested');
      apiFetch('/setup/monitoring', { method: 'POST', body: { enabled: true } }).catch((e) => { setStarting('failed'); setFailure({ ...(e as ApiError), text: error(e) }); });
    }
    const timer = setTimeout(() => { setPolls((n) => n + 1); void runChecks(); }, 5000);
    return () => clearTimeout(timer);
  }, [current, monitoring, fresh, passed, checking, starting, polls]); // eslint-disable-line react-hooks/exhaustive-deps
  const startingNow = current === 'monitoring' && monitoring && starting === 'requested' && !passed && polls < 36;

  const direction = useRef(1);
  const go = (step: Step) => { direction.current = steps.indexOf(step) >= steps.indexOf(current) ? 1 : -1; setCurrent(step); setResult(undefined); setFailure(undefined); };
  const next = () => go(steps[Math.min(steps.indexOf(current) + 1, steps.length - 1)]);
  async function save(status: 'completed' | 'skipped', data?: object) {
    setBusy(true); setFailure(undefined);
    try { await apiFetch(`/setup/steps/${current}`, { method: 'PUT', body: { status, data } }); await load(); next(); }
    catch (e) { setFailure({ ...(e as ApiError), text: error(e) }); }
    finally { setBusy(false); }
  }
  const chooseLocale = (l: string) => startLocale(async () => { const f = new FormData(); f.set('locale', l); await setLocale(f); router.refresh(); });

  if (gate === 'token') return <TokenGate onDone={() => load(true)}/>;
  if (gate === 'login') return <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: 'easeOut' }} className="w-full max-w-md"><Card><Card.Content className="flex flex-col gap-4 p-2">
    <span aria-hidden className="grid size-12 place-items-center rounded-xl bg-accent-soft text-accent-soft-foreground"><I name="user-check" size={22}/></span>
    <div><h1 className="text-xl font-semibold">{t('title')}</h1><p className="mt-1 text-sm text-muted">{t('gate.adminExists')}</p></div>
    <ButtonLink href="/login" className="w-full justify-center">{t('gate.toLogin')}<I name="arrow-right" size={16}/></ButtonLink>
  </Card.Content></Card></motion.div>;
  if (!progress) return <p role="status" className="text-center text-sm text-muted">{failure?.text ?? t('loading')}</p>;

  const index = steps.indexOf(current);
  const status = (s: Step) => s === 'admin' ? (progress.adminCreated ? 'completed' : undefined) : progress.steps[s]?.status;
  const isRequired = required.includes(current);
  const doneCount = steps.filter((s) => s !== 'summary' && status(s)).length;
  // A step opens once every required step before it is done (later steps need the admin's session, too).
  const reachable = (s: Step) => steps.slice(0, steps.indexOf(s)).every((x) => !required.includes(x) || !!status(x));
  const missing = required.filter((s) => !status(s));

  const skipButton = !isRequired && current !== 'summary' && <Button variant="ghost" isDisabled={busy || checking} onPress={() => save('skipped')}>{t('skip')}</Button>;
  const continueButton = (onPress: () => void, isDisabled = false) => <Button isPending={busy} isDisabled={isDisabled || checking} onPress={onPress}>{t('continue')}<I name="arrow-right" size={16}/></Button>;
  const checkButtons = (data: object) => checking ? <Button isPending>{t('checking')}</Button>
    : !fresh ? <Button isDisabled={!p} onPress={runChecks}><I name="search-check" size={16}/>{t('check')}</Button>
    : passed ? continueButton(() => save('completed', data))
    : <>{current === 'access' && <Button variant="secondary" isDisabled={busy} onPress={() => save('completed', data)}>{t('saveUnverified')}</Button>}
      <Button onPress={runChecks}><I name="rotate-cw" size={16}/>{t('recheck')}</Button></>;

  const actions = (() => {
    switch (current) {
      case 'language': return continueButton(() => save('completed', { locale }));
      case 'checks': case 'services': return checkButtons({});
      case 'access': return checkButtons({ publicUrl });
      case 'domain': return checkButtons({ domain });
      case 'admin': return progress.adminCreated && continueButton(next);
      case 'vmware': return status('vmware') === 'completed' && continueButton(next);
      case 'discovery': return continueButton(() => save('completed'), !hosts);
      case 'monitoring': return startingNow ? <Button isPending>{t('monitoring.starting')}</Button>
        : monitoring ? checkButtons({ enabled: true })
        : continueButton(async () => {
          // Unticked while it runs: stop it through the agent, then record the choice.
          if (monitorRunning) { try { await apiFetch('/setup/monitoring', { method: 'POST', body: { enabled: false } }); } catch (e) { setFailure({ ...(e as ApiError), text: error(e) }); return; } }
          await save('completed', { enabled: false });
        });
      case 'summary': return <Button isPending={busy} isDisabled={missing.length > 0} onPress={async () => {
        setBusy(true); setFailure(undefined);
        try { await apiFetch('/setup/complete', { method: 'POST' }); router.replace('/admin'); router.refresh(); }
        catch (e) { setFailure({ ...(e as ApiError), text: error(e) }); setBusy(false); }
      }}><I name="flag" size={16}/>{t('finish')}</Button>;
      default: return null;
    }
  })();

  return <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: 'easeOut' }} className="wizard grid w-full max-w-6xl gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
    <Card className="hidden self-start lg:block">
      <Card.Content className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between text-xs text-muted"><span className="font-semibold uppercase tracking-wider">{t('title')}</span><span className="tabular-nums">{t('doneOf', { n: doneCount, total: steps.length - 1 })}</span></div>
        <ProgressBar aria-label={t('title')} value={doneCount} maxValue={steps.length - 1} size="sm" color="success"><ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>
        <nav aria-label={t('title')} className="steps"><ol className="flex flex-col gap-0.5">{steps.map((s, i) => {
          const st = status(s), open = reachable(s);
          return <li key={s}>
            <button type="button" aria-current={s === current ? 'step' : undefined} disabled={!open} onClick={() => go(s)} title={open ? undefined : t('locked')}
              className={`relative flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors duration-150 ${s === current ? 'font-medium text-accent-soft-foreground' : open ? 'cursor-pointer hover:bg-default' : 'cursor-not-allowed opacity-50'}`}>
              {s === current && <motion.span layoutId="wizard-current" aria-hidden className="absolute inset-0 rounded-lg bg-accent-soft" transition={{ type: 'spring', stiffness: 420, damping: 34 }}/>}
              <span className={`relative grid size-6 shrink-0 place-items-center rounded-full text-xs tabular-nums transition-colors duration-300 ${st === 'completed' ? 'bg-success text-success-foreground' : st === 'skipped' ? 'bg-default text-muted' : s === current ? 'ring-2 ring-accent' : 'bg-default'}`}>
                {st === 'completed' ? <motion.span key="done" initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 18 }}><I name="check" size={13}/></motion.span> : st === 'skipped' ? <I name="minus" size={13}/> : !open ? <I name="lock" size={11}/> : i + 1}</span>
              <span className="relative flex-1">{t(`steps.${s}.title`)}</span>
              {required.includes(s) && !st && <span aria-label={t('required')} className="relative size-1.5 rounded-full bg-accent"/>}
              {st === 'skipped' && <span className="relative text-xs text-muted">{t('skippedShort')}</span>}
            </button></li>;
        })}</ol></nav>
      </Card.Content>
    </Card>
    <Card>
      <Card.Content className="flex flex-col gap-5">
        <div className="flex flex-col gap-2 lg:hidden">
          <div className="flex items-center justify-between text-xs text-muted"><span>{t('stepOf', { n: index + 1, total: steps.length })}</span><span className="tabular-nums">{t('doneOf', { n: doneCount, total: steps.length - 1 })}</span></div>
          <ProgressBar aria-label={t('title')} value={doneCount} maxValue={steps.length - 1} size="sm" color="success"><ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>
        </div>
        <motion.div key={current} initial={{ opacity: 0, x: 28 * direction.current }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }} className="flex flex-col gap-5">
        <div className="flex items-start gap-4">
          <motion.span aria-hidden initial={{ scale: 0.6, rotate: -12 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 16, delay: 0.05 }}
            className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-soft-foreground">{stepIcon[current]}</motion.span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted"><span className="hidden lg:inline">{t('stepOf', { n: index + 1, total: steps.length })}</span>
              {current !== 'summary' && <StatusChip tone={isRequired ? 'accent' : 'default'}>{isRequired ? t('required') : t('optional')}</StatusChip>}
              {status(current) === 'completed' && <StatusChip tone="success">{t('summary.completed')}</StatusChip>}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t(`steps.${current}.title`)}</h1>
            <p className="mt-1 text-sm text-muted">{t(`steps.${current}.help`)}</p>
          </div>
        </div>

        {current === 'language' && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label={t('steps.language.title')}>
          {(['tr', 'en'] as const).map((l) => <button key={l} type="button" lang={l} role="radio" aria-checked={l === locale} onClick={() => chooseLocale(l)}
            className={`flex min-h-14 items-center gap-3 rounded-xl border px-4 text-left transition-colors ${l === locale ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent'}`}>
            <span aria-hidden className="grid size-9 place-items-center rounded-lg bg-default font-mono text-xs font-semibold uppercase">{l}</span><span className="flex-1 font-medium">{l === 'tr' ? 'Türkçe' : 'English'}</span>
            {l === locale && <I name="circle-check" size={18} className="text-accent"/>}
          </button>)}
        </div>}
        {current === 'access' && <TextInput format="url" label={t('access.label')} value={publicUrl} onChange={setPublicUrl} error={field(failure?.fields?.publicUrl)} help={t('access.help')} isRequired/>}
        {current === 'admin' && (progress.adminCreated ? <Notice tone="success">{t('admin.done')}</Notice> : <CredentialsForm mode="setup" noToken onDone={() => load(true)}/>)}
        {current === 'domain' && <div className="flex flex-col gap-4">
          <TextInput format="domain" label={t('domain.label')} value={domain} onChange={setDomain} placeholder="panel.example.com" error={field(failure?.fields?.domain)} help={t('domain.help')}/>
          <Notice tone="default" title={t('domain.autoTitle')}>{t('domain.auto')}</Notice>
        </div>}
        {current === 'vmware' && <>{status('vmware') === 'completed' ? <Notice tone="success">{t('vmware.done')}</Notice> : <p className="text-sm text-muted">{t('vmware.note')}</p>}
          <ConnectionForm onSaved={() => save('completed')}/></>}
        {current === 'discovery' && <Discovered onHosts={setHosts}/>}
        {notYetAvailable.includes(current) && <Notice tone="default">{t(`notAvailable.${current as 'pools'}`)}</Notice>}
        {current === 'monitoring' && <div className="flex flex-col gap-3">
          <CheckboxInput label={t('monitoring.enable')} isSelected={monitoring} onChange={setMonitoring}/>
          {!startingNow && <p className="text-sm text-muted">{monitorRunning ? t('monitoring.running') : t('monitoring.auto')}</p>}
          {startingNow && <p role="status" className="flex items-center gap-2 text-sm text-accent"><I name="loader-circle" size={16} className="animate-spin motion-reduce:animate-none"/>{t('monitoring.startingHelp')}</p>}
          {failure?.code === 'MAINTENANCE_AGENT_MISSING' && <pre className="overflow-x-auto rounded-lg bg-default p-3 font-mono text-xs">sudo sh scripts/install.sh agent on</pre>}
        </div>}
        {current === 'summary' && <Summary progress={progress} status={status}/>}

        {checking && !fresh && <ul aria-busy className="flex flex-col gap-2">{[0, 1, 2].map((i) => <li key={i} className="h-11 animate-pulse rounded-xl bg-default"/>)}</ul>}
        {fresh && !startingNow && <>
          <motion.p key={String(passed)} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.2 }} role="status" className={`flex items-center gap-2 text-sm font-medium ${passed ? 'text-success' : 'text-danger'}`}>
            <I name={passed ? 'circle-check' : 'circle-alert'} size={16}/>{passed ? t('allPassed') : t('someFailed', { n: result!.checks.filter((c) => !c.ok).length })}</motion.p>
          <CheckList checks={result!.checks}/>
        </>}
        {fresh && startingNow && <CheckList checks={result!.checks.map((c) => c.ok ? c : { ...c, code: 'STARTING' })}/>}
        {current === 'access' && fresh && !passed && <p className="text-sm text-muted">{t(`access.hint.${result!.checks[0].code}` as 'access.hint.DNS_FAILED')} {t('unverifiedHelp')}</p>}
        {current === 'domain' && fresh && result!.checks.filter((c) => !c.ok).map((c) => <p key={c.id} className="text-sm text-muted">{t(`domain.hint.${c.code}` as 'domain.hint.DNS_FAILED')}</p>)}
        {current === 'domain' && fresh && result!.checks.some((c) => c.id === 'dns' && c.detail?.aaaa) && <p className="text-sm text-muted">{t('domain.aaaaWarning')}</p>}
        {current === 'summary' && missing.length > 0 && <Notice tone="warning">{t('finishBlockedShort')}
          {/* Each missing step is one press away. */}
          <span className="mt-2 flex flex-wrap gap-2">{missing.map((m) => <Button key={m} size="sm" variant="secondary" onPress={() => go(m)}><I name="arrow-right" size={14}/>{t(`steps.${m}.title`)}</Button>)}</span></Notice>}
        {failure && !failure.fields && <div role="alert"><Notice tone="danger">{failure.text}</Notice></div>}

        </motion.div>

        {/* Back on the left, the step's action on the right; on a narrow screen the actions wrap under each other, right-aligned. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-separator pt-4">
          {index > 0 && <Button variant="tertiary" onPress={() => go(steps[index - 1])}><I name="arrow-left" size={16}/>{t('back')}</Button>}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{skipButton}{actions}</div>
        </div>
      </Card.Content>
    </Card>
  </motion.div>;
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
      <span className="flex items-center gap-2"><span className="text-muted" aria-hidden>{stepIcon[s]}</span><strong>{t(`steps.${s}.title`)}</strong>{required.includes(s) && <span className="text-muted"> · {t('required')}</span>}</span>
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
    try { await apiFetch('/setup/session', { method: 'POST', body: { token: token.trim() } }); onDone(); }
    catch (err) { setFailure(error(err)); } finally { setBusy(false); }
  }
  return <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: 'easeOut' }} className="w-full max-w-lg"><Card><Card.Content className="flex flex-col gap-4 p-2">
    <span aria-hidden className="grid size-12 place-items-center rounded-xl bg-accent-soft text-accent-soft-foreground"><I name="key-round" size={22}/></span>
    <h1 className="text-xl font-semibold">{t('title')}</h1><p className="text-sm text-muted">{t('gate.text')}</p>
    <pre className="overflow-x-auto rounded-lg bg-default p-3 font-mono text-xs">docker compose exec api node dist/cli.js bootstrap-token</pre>
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <TextInput label={t('gate.token')} type="password" value={token} onChange={setToken} autoComplete="one-time-code" spellCheck={false} help={t('gate.tokenHelp')} isRequired/>
      {failure && <p role="alert" className="text-sm text-danger">{failure}</p>}
      <Button type="submit" isPending={busy} isDisabled={!token.trim()}>{t('gate.submit')}<I name="arrow-right" size={16}/></Button>
    </form>
  </Card.Content></Card></motion.div>;
}

// Summary of what the saved connections discovered; details live on the admin VMware page.
function Discovered({ onHosts }: { onHosts: (n: number) => void }) {
  const t = useTranslations('Setup');
  const { error } = useErrorText();
  const [rows, setRows] = useState<{ id: string; name: string; kind: string; hosts: number; vms: number }[]>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    apiFetch<{ connections: NonNullable<typeof rows> }>('/admin/vmware/connections').then((r) => { setRows(r.connections); onHosts(r.connections.reduce((a, c) => a + c.hosts, 0)); }, (e) => setFailure(error(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failure) return <p role="alert" className="text-sm text-danger">{failure}</p>;
  if (!rows) return <ul aria-busy className="flex flex-col gap-2">{[0, 1].map((i) => <li key={i} className="h-11 animate-pulse rounded-xl bg-default"/>)}</ul>;
  if (!rows.length) return <Notice tone="warning">{t('discovery.none')}</Notice>;
  return <ul className="checks flex flex-col gap-2">{rows.map((c) => <li key={c.id} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm ${c.hosts ? 'ok border-success/30 bg-success/5' : 'fail border-danger/30 bg-danger/5'}`}>
    <I name={c.hosts ? 'circle-check' : 'circle-x'} size={18} className={c.hosts ? 'text-success' : 'text-danger'}/>{t('discovery.row', { name: c.name, hosts: c.hosts, vms: c.vms })}</li>)}</ul>;
}
