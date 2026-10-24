"use client";
import { Button, Card } from '@heroui/react';
import { I } from '../../../../components/icon';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { FieldGroup, Mono, Notice, SelectInput, TextInput } from '../../../../components/ui';
import { apiVersions, versionLabel } from './connections';

type Certificate = { subject: string; issuer: string; notAfter: string; sha256: string; dnsNames: string[] | null; ips: string[] | null };
type Failure = ApiError & { text: string; certificate?: Certificate; conflicts?: { host: string; connection: string }[] };
export type Summary = { id?: string; product: { kind: string; fullName: string }; writeApi: string; operations: Record<string, boolean>; warnings: string[]; counts: Record<string, number> };

const fingerprintPairs = (hex: string) => hex.match(/../g)?.join(':').toUpperCase() ?? hex;

// Shared by the admin page and the setup wizard. Certificate trust is an explicit admin decision:
// an untrusted certificate is shown with its fingerprint and can be pinned, never ignored.
export default function ConnectionForm({ onSaved }: { onSaved: (s: Summary) => void }) {
  const t = useTranslations('Vmware');
  const { error, field } = useErrorText();
  const [form, setForm] = useState({ name: '', host: '', port: '443', username: '', password: '', mode: 'system', caPem: '', sha256: '', apiVersion: '', customization: 'auto' });
  const [failure, setFailure] = useState<Failure>();
  const [tested, setTested] = useState<Summary>();
  const [busy, setBusy] = useState<'test' | 'save'>();
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const body = () => ({ name: form.name, host: form.host, port: Number(form.port), username: form.username, password: form.password, apiVersion: form.apiVersion, customization: form.customization,
    tls: { mode: form.mode, ...(form.mode === 'ca' && { caPem: form.caPem }), ...(form.mode === 'pinned' && { sha256: form.sha256 }) } });

  async function run(kind: 'test' | 'save', path: string, onOk: (s: Summary) => void) {
    setBusy(kind); setFailure(undefined); setTested(undefined);
    try { onOk(await apiFetch<Summary>(path, { method: 'POST', body: body() })); }
    catch (e) { setFailure({ ...(e as Failure), text: error(e) }); }
    finally { setBusy(undefined); }
  }
  const err = (k: string) => field(failure?.fields?.[k]);
  const help = (k: string) => t(`form.${k}Help` as 'form.nameHelp');

  return <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); run('save', '/admin/vmware/connections', onSaved); }} noValidate>
    <FieldGroup title={t('form.groupEndpoint')} description={t('form.groupEndpointHelp')}>
      <TextInput label={t('form.name')} value={form.name} onChange={set('name')} error={err('name')} help={help('name')} isRequired/>
      <TextInput label={t('form.host')} value={form.host} onChange={set('host')} error={err('host')} help={help('host')} isRequired autoComplete="off" spellCheck={false}/>
      <TextInput label={t('form.port')} value={form.port} onChange={set('port')} error={err('port')} help={help('port')} autoComplete="off"/>
    </FieldGroup>
    <FieldGroup title={t('form.groupAccount')} description={t('form.groupAccountHelp')}>
      <TextInput label={t('form.username')} value={form.username} onChange={set('username')} error={err('username')} help={help('username')} isRequired autoComplete="off"/>
      <TextInput label={t('form.password')} type="password" value={form.password} onChange={set('password')} error={err('password')} help={help('password')} isRequired autoComplete="new-password"/>
    </FieldGroup>
    <FieldGroup title={t('form.groupTls')} description={t('form.tlsHelp')} cols={1}>
      <SelectInput label={t('form.tls')} value={form.mode} onChange={set('mode')} options={(['system', 'ca', 'pinned'] as const).map((m) => ({ id: m, label: t(`tlsMode.${m}`) }))}/>
      {form.mode === 'ca' && <TextInput multiline label={t('form.caPem')} value={form.caPem} onChange={set('caPem')} error={err('caPem')} help={t('form.caPemHelp')} spellCheck={false}/>}
      {form.mode === 'pinned' && <TextInput label={t('form.sha256')} value={form.sha256} onChange={set('sha256')} error={err('sha256')} help={t('form.sha256Help')} spellCheck={false}/>}
    </FieldGroup>
    <FieldGroup title={t('compat.title')} description={t('compat.formHelp')}>
      <SelectInput label={t('compat.version')} value={form.apiVersion} onChange={set('apiVersion')} error={err('apiVersion')} help={t('compat.versionHelp')}
        options={[{ id: '', label: t('compat.auto') }, ...apiVersions.map((v) => ({ id: v, label: versionLabel(v), description: `API ${v}` }))]}/>
      <SelectInput label={t('compat.customization')} value={form.customization} onChange={set('customization')} error={err('customization')} help={t('compat.customizationHelp')}
        options={(['auto', 'cloudinit', 'guestinfo'] as const).map((m) => ({ id: m, label: t(`compat.method.${m}`), description: t(`compat.methodHelp.${m}`) }))}/>
    </FieldGroup>

    {failure && <div role="alert"><Notice tone="danger" title={failure.text}>
      {failure.conflicts && <ul className="list-disc pl-5">{failure.conflicts.map((c) => <li key={c.host}>{t('conflict', { host: c.host, connection: c.connection })}</li>)}</ul>}
    </Notice></div>}
    {failure?.certificate && <Card variant="secondary" className="border border-warning/40">
      <Card.Header>
        <Card.Title className="flex items-center gap-2 text-base"><I name="shield-alert" size={18} className="text-warning"/>{t('cert.title')}</Card.Title>
        <Card.Description>{t('cert.explain')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3 text-sm">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted">{t('cert.subject')}</dt><dd className="break-all">{failure.certificate.subject}</dd>
          <dt className="text-muted">{t('cert.issuer')}</dt><dd className="break-all">{failure.certificate.issuer}</dd>
          <dt className="text-muted">{t('cert.notAfter')}</dt><dd>{failure.certificate.notAfter}</dd>
          <dt className="text-muted">{t('cert.names')}</dt><dd className="break-all">{[...(failure.certificate.dnsNames ?? []), ...(failure.certificate.ips ?? [])].join(', ') || '–'}</dd>
          <dt className="text-muted">SHA-256</dt><dd className="break-all"><Mono>{fingerprintPairs(failure.certificate.sha256)}</Mono></dd>
        </dl>
        <p className="text-muted">{t('cert.verify')}</p>
        <pre className="overflow-x-auto rounded-lg bg-default p-3 font-mono text-xs">openssl x509 -in /etc/vmware/ssl/rui.crt -noout -fingerprint -sha256</pre>
        <div><Button variant="secondary" onPress={() => { setForm((f) => ({ ...f, mode: 'pinned', sha256: failure.certificate!.sha256 })); setFailure(undefined); }}>{t('cert.pin')}</Button></div>
      </Card.Content>
    </Card>}
    {tested && <div role="status"><Notice tone="success" title={t('testOk', { kind: tested.product.fullName, hosts: tested.counts.hosts, vms: tested.counts.vms })}/></div>}

    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="secondary" isPending={busy === 'test'} isDisabled={!!busy} onPress={() => run('test', '/admin/vmware/test', setTested)}>{busy === 'test' ? t('working') : t('test')}</Button>
      <Button type="submit" isPending={busy === 'save'} isDisabled={!!busy}>{t('save')}</Button>
    </div>
  </form>;
}
