"use client";
// The panel's address and certificate: what is served now, and a change to a new name with Let's Encrypt or
// your own certificate. The host agent applies it (scripts/install.sh domain) and rolls back on failure.
import { Button, Card, Meter, Spinner, toast } from '@heroui/react';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { I } from '../../../../components/icon';
import { GuideButton } from '../../../../components/setup-guide';
import { ConfirmButton, FormSection, Mono, Notice, StatusChip, TextInput, Loading } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Cert = { subject: string; issuer: string; names: string[]; validFrom: string; validTo: string; daysLeft: number; fingerprint: string; trusted?: boolean; staging?: boolean;
  chainLength?: number; keyType?: string; warnings?: string[] };
type Current = { site: string | null; tlsMode: 'acme' | 'staging' | 'custom' | 'none'; agent: boolean; certificate: Cert | null; dns: { a: string[]; aaaa: string[] } | null };
type Check = { domain: string; a: string[]; aaaa: string[]; sameServer: boolean | null };
type Agent = { agent: { pending: number; status: { id: string; action: string; state: 'running' | 'succeeded' | 'failed' | 'rejected'; code: string } | null; log: string[] } };

function CertFacts({ c }: { c: Cert }) {
  const t = useTranslations('Settings.domain');
  const format = useFormatter();
  const tone = c.daysLeft < 7 ? 'danger' : c.daysLeft < 30 ? 'warning' : 'success';
  return <dl className="grid gap-3 text-sm sm:grid-cols-2">
    <div><dt className="text-muted">{t('issuer')}</dt><dd className="mt-0.5 flex flex-wrap items-center gap-2">{c.issuer || '–'}
      {c.trusted === false && <StatusChip tone={c.staging ? 'warning' : 'danger'}>{c.staging ? t('stagingCert') : t('untrusted')}</StatusChip>}
      {c.trusted && <StatusChip tone="success">{t('trusted')}</StatusChip>}</dd></div>
    <div><dt className="text-muted">{t('names')}</dt><dd className="mt-0.5 flex flex-wrap gap-1">{c.names.map((n) => <Mono key={n}>{n}</Mono>)}</dd></div>
    <div className="sm:col-span-2"><dt className="text-muted">{t('validity')}</dt>
      <dd className="mt-1 flex flex-col gap-1.5">
        <Meter aria-label={t('validity')} value={Math.max(0, Math.min(100, (c.daysLeft / 90) * 100))} size="sm" color={tone}><Meter.Track><Meter.Fill/></Meter.Track></Meter>
        <span className="text-xs text-muted">{t('validRange', { from: format.dateTime(new Date(c.validFrom), { dateStyle: 'medium' }), to: format.dateTime(new Date(c.validTo), { dateStyle: 'medium' }), days: c.daysLeft })}</span>
      </dd></div>
    <div className="sm:col-span-2"><dt className="text-muted">SHA-256</dt><dd className="mt-0.5 break-all font-mono text-xs">{c.fingerprint}</dd></div>
  </dl>;
}

export default function Domain({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.domain');
  const { error, field } = useErrorText();
  const cur = useApiQuery<Current>(['settings', 'domain'], '/admin/domain').data;
  const [domain, setDomain] = useState('');
  const [tls, setTls] = useState<'acme' | 'staging' | 'custom'>('acme');
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [checked, setChecked] = useState<Check | null>(null);
  const [certInfo, setCertInfo] = useState<Cert | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'check' | 'cert' | 'apply'>();
  const [queued, setQueued] = useState<string | null>(null);
  const agent = useApiQuery<Agent>(['admin', 'maintenance'], queued ? '/admin/maintenance' : null, { refetchInterval: 3000 }).data?.agent;
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [agent?.log.length]);
  if (!cur) return <Loading of={['settings', 'domain']}/>;

  async function run<T>(kind: 'check' | 'cert' | 'apply', path: string, body: unknown) {
    setBusy(kind); setFields({});
    try { return await apiFetch<T>(path, { method: 'POST', body }); }
    catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); return null; } finally { setBusy(undefined); }
  }
  const readFile = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) void f.text().then(set); e.target.value = ''; };
  const ready = !!domain && (tls !== 'custom' || !!certInfo);
  const st = agent?.status;
  const done = queued && st?.id === queued && st.state !== 'running';

  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('current')} description={t('currentHelp')} icon={<I name="globe" size={16}/>} aside={<GuideButton id="domain"/>}>
      {!cur.site ? <Notice tone="default">{t('noDomain')}</Notice> : <>
        <div className="flex flex-wrap items-center gap-2">
          <a href={`https://${cur.site}`} className="font-mono text-base font-semibold text-accent hover:underline">{cur.site}</a>
          <StatusChip tone="accent">{t(`modes.${cur.tlsMode}`)}</StatusChip>
          {cur.dns && <span className="text-xs text-muted">A: {cur.dns.a.join(', ') || '–'}{cur.dns.aaaa.length > 0 && ` · AAAA: ${cur.dns.aaaa.join(', ')}`}</span>}
        </div>
        {cur.certificate ? <CertFacts c={cur.certificate}/> : <Notice tone="warning">{t('noCertificate')}</Notice>}
      </>}
    </FormSection>

    {!readOnly && <>
      <FormSection title={t('change')} description={t('changeHelp')} icon={<I name="arrow-right-left" size={16}/>}>
        {!cur.agent && <Notice tone="warning" title={t('agentMissingTitle')}>{t('agentMissing')} <Mono>sudo sh scripts/install.sh agent on</Mono></Notice>}
        <div className="flex flex-wrap items-start gap-2">
          <TextInput format="domain" className="min-w-60 flex-1" label={t('newDomain')} value={domain} placeholder="panel.example.com" spellCheck={false} autoComplete="off"
            onChange={(v) => { setDomain(v.trim().toLowerCase()); setChecked(null); setCertInfo(null); }} error={field(fields.domain)} help={t('newDomainHelp')}/>
          <Button className="mt-6" variant="secondary" isPending={busy === 'check'} isDisabled={!domain}
            onPress={async () => setChecked(await run<Check>('check', '/admin/domain/check', { domain }))}><I name="search-check" size={16}/>{t('checkDns')}</Button>
        </div>
        {checked && <div className="flex flex-col gap-1 rounded-xl border border-border p-3 text-sm" aria-live="polite">
          <p>A: <Mono>{checked.a.join(', ') || '–'}</Mono>{checked.aaaa.length > 0 && <> · AAAA: <Mono>{checked.aaaa.join(', ')}</Mono></>}</p>
          {!checked.a.length ? <p className="text-danger">{t('noARecord')}</p>
            : checked.sameServer === true ? <p className="text-success">{t('sameServer')}</p>
            : checked.sameServer === false ? <p className="text-warning">{t('otherServer')}</p>
            : <p className="text-muted">{t('cannotCompare')}</p>}
        </div>}
      </FormSection>

      <FormSection title={t('certificate')} description={t('certificateHelp')} icon={<I name="lock-keyhole" size={16}/>}>
        <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label={t('certificate')}>
          {(['acme', 'staging', 'custom'] as const).map((m) => <button key={m} type="button" role="radio" aria-checked={tls === m} onClick={() => { setTls(m); setCertInfo(null); }}
            className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors ${tls === m ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent'}`}>
            <span className="text-sm font-semibold">{t(`modes.${m}`)}</span><span className="text-xs text-muted">{t(`modeHelp.${m}`)}</span>
          </button>)}
        </div>
        {tls === 'custom' && <div className="flex flex-col gap-3">
          <TextInput label={t('certPem')} multiline value={cert} onChange={(v) => { setCert(v); setCertInfo(null); }} error={field(fields.cert)} help={t('certPemHelp')} spellCheck={false}
            placeholder="-----BEGIN CERTIFICATE-----"/>
          <label className="inline-flex w-fit cursor-pointer items-center gap-2 text-sm text-accent hover:underline"><I name="file-up" size={14}/>{t('fromFile')}
            <input type="file" accept=".pem,.crt,.cer,.txt" className="sr-only" onChange={readFile((v) => { setCert(v); setCertInfo(null); })}/></label>
          <TextInput label={t('keyPem')} multiline value={key} onChange={(v) => { setKey(v); setCertInfo(null); }} error={field(fields.key)} help={t('keyPemHelp')} spellCheck={false}
            placeholder="-----BEGIN PRIVATE KEY-----"/>
          <label className="inline-flex w-fit cursor-pointer items-center gap-2 text-sm text-accent hover:underline"><I name="file-up" size={14}/>{t('fromFile')}
            <input type="file" accept=".pem,.key,.txt" className="sr-only" onChange={readFile((v) => { setKey(v); setCertInfo(null); })}/></label>
          <div><Button variant="secondary" isPending={busy === 'cert'} isDisabled={!cert || !key || !domain}
            onPress={async () => setCertInfo(await run<Cert>('cert', '/admin/domain/certificate', { cert, key, domain }))}><I name="badge-check" size={16}/>{t('validate')}</Button></div>
          {certInfo && <div className="flex flex-col gap-3 rounded-xl border border-success/40 p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-success"><I name="circle-check" size={16}/>{t('certOk', { chain: certInfo.chainLength ?? 1, key: certInfo.keyType ?? '' })}</p>
            <CertFacts c={certInfo}/>
            {certInfo.warnings?.map((w) => <Notice key={w} tone="warning">{t(`warnings.${w}` as 'warnings.SELF_SIGNED')}</Notice>)}
          </div>}
        </div>}
      </FormSection>

      <div className="flex flex-col gap-3 border-t border-separator pt-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ConfirmButton variant="primary" icon={<I name="rocket" size={16}/>} label={t('apply')} isDisabled={!ready || !cur.agent || !!busy || (!!queued && !done)}
            title={t('confirmTitle', { domain })} body={<ul className="list-disc space-y-1 pl-5">{(['c1', 'c2', 'c3', 'c4'] as const).map((k) => <li key={k}>{t(`confirm.${k}`, { domain })}</li>)}</ul>}
            confirmLabel={t('apply')} cancelLabel={t('cancel')}
            onConfirm={async () => { const r = await run<{ id: string }>('apply', '/admin/domain', { domain, tls, ...(tls === 'custom' && { cert, key }) }); if (r) { setQueued(r.id); toast.success(t('queued')); } }}/>
        </div>
        {queued && <div className="flex flex-col gap-2 rounded-2xl border border-border p-4" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            {!done && <Spinner size="sm" color="current"/>}
            <p className="font-medium">{!st || st.id !== queued ? t('waiting') : st.state === 'running' ? t('running') : st.state === 'succeeded' ? t('succeeded') : t('failed', { code: st.code })}</p>
          </div>
          {st?.id === queued && st.state === 'succeeded' && <Notice tone="success">{t('goTo')} <a className="font-semibold text-accent underline" href={`https://${domain}/admin/settings?tab=domain`}>https://{domain}</a></Notice>}
          {st?.id === queued && st.state === 'failed' && <Notice tone="danger">{t('rolledBack')}</Notice>}
          {!done && <p className="text-xs text-muted">{t('mayDisconnect', { domain })}</p>}
          {!!agent?.log.length && st?.id === queued && <pre ref={logRef} aria-label={t('log')} className="max-h-64 overflow-auto rounded-xl bg-default/60 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{agent.log.join('\n')}</pre>}
        </div>}
      </div>
    </>}
  </Card.Content></Card>;
}
