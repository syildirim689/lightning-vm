"use client";
import { Button, Card } from '@heroui/react';
import { I } from '../../../../components/icon';
import { GuideButton } from '../../../../components/setup-guide';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { FieldGroup, Mono, Notice, SelectInput, TextInput } from '../../../../components/ui';
import { apiVersions, versionLabel } from './connections';

type Certificate = { subject: string; issuer: string; notAfter: string; sha256: string; dnsNames: string[] | null; ips: string[] | null };
type Failure = ApiError & { text: string; certificate?: Certificate; kind?: string; conflicts?: { host: string; connection: string }[] };
export type Summary = { id?: string; product: { kind: string; fullName: string }; writeApi: string; operations: Record<string, boolean>; warnings: string[]; counts: Record<string, number> };

export const fingerprintPairs = (hex: string) => hex.match(/../g)?.join(':').toUpperCase() ?? hex;
// Filled in from a network scan (discovery.tsx). A fingerprint seen there is pinned only after the admin compares it.
export type Prefill = { name: string; host: string; port: string; username: string; mode: 'system' | 'pinned'; sha256: string; kind: 'esxi' | 'vcenter' };
// Where an admin reads the certificate fingerprint on the endpoint itself.
export const fingerprintCommand = (kind: 'esxi' | 'vcenter' | 'proxmox' | 'xcpng' | 'ovirt') => kind === 'proxmox' ? 'openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256'
  : kind === 'xcpng' ? 'openssl x509 -in /etc/xensource/xapi-ssl.pem -noout -fingerprint -sha256'
  : kind === 'ovirt' ? 'openssl x509 -in /etc/pki/ovirt-engine/certs/apache.cer -noout -fingerprint -sha256' : kind === 'vcenter'
  ? '/usr/lib/vmware-vmafd/bin/vecs-cli entry getcert --store MACHINE_SSL_CERT --alias __MACHINE_CERT | openssl x509 -noout -fingerprint -sha256'
  : 'openssl x509 -in /etc/vmware/ssl/rui.crt -noout -fingerprint -sha256';

// A saved connection opened for editing. The password is never sent back: left empty, the stored one is kept.
export type Editing = { id: string; name: string; kind: string; host: string; port: number; username: string; tlsMode: string; tlsSha256: string | null; tlsCaPem: string | null;
  apiVersion: string | null; customization: string; status?: string; lastErrorCode?: string | null };
type Form = { platform: 'vmware' | 'proxmox' | 'xcpng' | 'ovirt'; name: string; host: string; port: string; username: string; password: string; mode: string; caPem: string; sha256: string; apiVersion: string; customization: string };
const knownKind = (k?: string): 'esxi' | 'vcenter' | 'proxmox' | 'xcpng' | 'ovirt' | undefined => (k === 'esxi' || k === 'vcenter' || k === 'proxmox' || k === 'xcpng' || k === 'ovirt' ? k : undefined);

// Shared by the admin page and the setup wizard. Certificate trust is an explicit admin decision:
// an untrusted certificate is shown with its fingerprint and can be pinned, never ignored.
export default function ConnectionForm({ onSaved, initial, editing }: { onSaved: (s: Summary) => void; initial?: Prefill; editing?: Editing }) {
  const t = useTranslations('Vmware');
  const { error, field } = useErrorText();
  const [form, setForm] = useState<Form>({ platform: editing?.kind === 'proxmox' || editing?.kind === 'xcpng' || editing?.kind === 'ovirt' ? editing.kind : 'vmware', name: '', host: '', port: '443', username: '', password: '', mode: 'system', caPem: '', sha256: '', apiVersion: '', customization: 'auto',
    ...(initial && { name: initial.name, host: initial.host, port: initial.port, username: initial.username, mode: initial.mode, sha256: initial.sha256 }),
    ...(editing && { name: editing.name, host: editing.host, port: String(editing.port), username: editing.username, mode: editing.tlsMode, caPem: editing.tlsCaPem ?? '',
      sha256: editing.tlsSha256 ?? '', apiVersion: editing.apiVersion ?? '', customization: editing.customization }) });
  const [failure, setFailure] = useState<Failure>();
  const [tested, setTested] = useState<Summary>();
  const [testedFor, setTestedFor] = useState('');
  const [busy, setBusy] = useState<'test' | 'save'>();
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const proxmox = form.platform === 'proxmox', xcpng = form.platform === 'xcpng', ovirt = form.platform === 'ovirt', other = proxmox || xcpng || ovirt;
  // The other platform answers on another port; a port typed by hand is kept.
  const choose = (p: Form['platform']) => setForm((x) => ({ ...x, platform: p, port: x.port === '443' || x.port === '8006' || !x.port ? (p === 'proxmox' ? '8006' : '443') : x.port, ...(p === 'xcpng' && !x.username && { username: 'root' }), ...(p === 'ovirt' && !x.username && { username: 'admin@internal' }) }));
  const bodyOf = (v: Form) => ({ platform: v.platform, name: v.name, host: v.host, port: Number(v.port), username: v.username, password: v.password, apiVersion: v.apiVersion, customization: v.customization,
    tls: { mode: v.mode, ...(v.mode === 'ca' && { caPem: v.caPem }), ...(v.mode === 'pinned' && { sha256: v.sha256 }) }, ...(editing && { connectionId: editing.id }) });
  const body = () => bodyOf(form);
  // Which product the fingerprint command is for: from the failure, the scan or the saved connection; unknown for a new address.
  const kind = other ? form.platform as 'proxmox' | 'xcpng' | 'ovirt' : knownKind(failure?.kind) ?? knownKind(editing?.kind) ?? knownKind(initial?.kind);

  async function run(step: 'test' | 'save', path: string, onOk: (s: Summary) => void, payload = body()) {
    setBusy(step); setFailure(undefined); setTested(undefined);
    try { onOk(await apiFetch<Summary>(path, { method: step === 'save' && editing ? 'PUT' : 'POST', body: payload })); }
    catch (e) { setFailure({ ...(e as Failure), text: error(e) }); }
    finally { setBusy(undefined); }
  }
  const test = (v: Form) => { const payload = bodyOf(v); const k = JSON.stringify(payload); void run('test', '/admin/vmware/test', (s) => { setTested(s); setTestedFor(k); }, payload); };
  // Pinning is the admin's decision after comparing the fingerprint; the test then runs again on its own.
  const pin = (sha256: string) => { const next = { ...form, mode: 'pinned', sha256 }; setForm(next); test(next); };
  const savePath = editing ? `/admin/vmware/connections/${editing.id}` : '/admin/vmware/connections';
  const err = (k: string) => field(failure?.fields?.[k]);
  const help = (k: string) => t(`form.${k}Help` as 'form.nameHelp');

  return <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (tested && testedFor === JSON.stringify(body())) void run('save', savePath, onSaved); }} noValidate>
    {!editing && <GuideButton id="vmware"/>}
    {editing && editing.status !== 'ok' && !failure && !tested && <Notice tone="danger" title={error({ code: editing.lastErrorCode })}>{t('fixHelp')}</Notice>}
    {initial && <Notice tone={initial.mode === 'pinned' ? 'warning' : 'success'} title={t(initial.mode === 'pinned' ? 'scan.prefillPinned' : 'scan.prefillTrusted')}>
      {initial.mode === 'pinned' && <div className="flex flex-col gap-2">
        <p>{t('scan.prefillPinnedHelp')}</p>
        <Mono>{fingerprintPairs(initial.sha256)}</Mono>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-default p-3 font-mono text-xs">{fingerprintCommand(initial.kind)}</pre>
      </div>}
    </Notice>}
    {!editing && <div className="flex flex-col gap-2">
      <p id="conn-platform" className="text-sm font-medium">{t('platform.label')}</p>
      <div role="radiogroup" aria-labelledby="conn-platform" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {(['vmware', 'proxmox', 'xcpng', 'ovirt'] as const).map((p) => <button key={p} type="button" role="radio" aria-checked={form.platform === p} onClick={() => choose(p)}
          className={`flex min-h-14 items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent ${form.platform === p ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/50'}`}>
          <span className="mt-0.5 shrink-0 text-accent">{form.platform === p ? <I name="circle-check" size={18}/> : <I name="circle" size={18}/>}</span>
          <span className="flex flex-col"><span className="text-sm font-medium">{t(`platform.${p}`)}</span><span className="text-xs text-muted">{t(`platform.${p}Help`)}</span></span>
        </button>)}
      </div>
    </div>}
    <FieldGroup title={t('form.groupEndpoint')} description={t(proxmox ? 'platform.endpointHelp' : xcpng ? 'platform.xcpngEndpointHelp' : ovirt ? 'platform.ovirtEndpointHelp' : 'form.groupEndpointHelp')}>
      <TextInput maxLength={100} label={t('form.name')} value={form.name} onChange={set('name')} error={err('name')} help={help('name')} isRequired/>
      <TextInput format="hostOrIp" label={t('form.host')} value={form.host} onChange={set('host')} error={err('host')} help={help('host')} isRequired autoComplete="off" spellCheck={false}/>
      <TextInput format="port" label={t('form.port')} value={form.port} onChange={set('port')} error={err('port')} help={help('port')} autoComplete="off"/>
    </FieldGroup>
    <FieldGroup title={t('form.groupAccount')} description={t('form.groupAccountHelp')}>
      <TextInput maxLength={200} label={t('form.username')} value={form.username} onChange={set('username')} error={err('username')} help={proxmox ? t('platform.usernameHelp') : xcpng ? t('platform.xcpngUsernameHelp') : ovirt ? t('platform.ovirtUsernameHelp') : help('username')} placeholder={proxmox ? 'root@pam' : xcpng ? 'root' : ovirt ? 'admin@internal' : undefined} isRequired autoComplete="off"/>
      <TextInput revealable label={t('form.password')} type="password" value={form.password} onChange={set('password')} error={err('password')}
        help={editing ? t('form.passwordKeep') : proxmox ? t('platform.passwordHelp') : help('password')} placeholder={editing ? t('form.passwordKeepPlaceholder') : undefined} isRequired={!editing} autoComplete="new-password"/>
    </FieldGroup>
    <FieldGroup title={t('form.groupTls')} description={t('form.tlsHelp')} cols={1}>
      <SelectInput label={t('form.tls')} value={form.mode} onChange={set('mode')} options={(['system', 'ca', 'pinned'] as const).map((m) => ({ id: m, label: t(`tlsMode.${m}`) }))}/>
      {form.mode === 'ca' && <TextInput maxLength={20000} multiline label={t('form.caPem')} value={form.caPem} onChange={set('caPem')} error={err('caPem')} help={t('form.caPemHelp')} spellCheck={false}/>}
      {form.mode === 'pinned' && <TextInput label={t('form.sha256')} value={form.sha256} onChange={set('sha256')} error={err('sha256')} help={t('form.sha256Help')} spellCheck={false}/>}
    </FieldGroup>
    {!other && <FieldGroup title={t('compat.title')} description={t('compat.formHelp')}>
      <SelectInput label={t('compat.version')} value={form.apiVersion} onChange={set('apiVersion')} error={err('apiVersion')} help={t('compat.versionHelp')}
        options={[{ id: '', label: t('compat.auto') }, ...apiVersions.map((v) => ({ id: v, label: versionLabel(v), description: `API ${v}` }))]}/>
      <SelectInput label={t('compat.customization')} value={form.customization} onChange={set('customization')} error={err('customization')} help={t('compat.customizationHelp')}
        options={(['auto', 'cloudinit', 'guestinfo'] as const).map((m) => ({ id: m, label: t(`compat.method.${m}`), description: t(`compat.methodHelp.${m}`) }))}/>
    </FieldGroup>}

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
        {(kind ? [kind] : (['esxi', 'vcenter'] as const)).map((k) => <div key={k} className="flex flex-col gap-1">
          <p className="text-muted">{t(k === 'proxmox' ? 'platform.verify' : k === 'xcpng' ? 'platform.xcpngVerify' : k === 'ovirt' ? 'platform.ovirtVerify' : k === 'vcenter' ? 'cert.verifyVcenter' : 'cert.verify')}</p>
          <pre className="overflow-x-auto rounded-lg bg-default p-3 font-mono text-xs">{fingerprintCommand(k)}</pre>
        </div>)}
        <div><Button variant="secondary" isDisabled={!!busy} onPress={() => pin(failure.certificate!.sha256)}>{t('cert.pin')}</Button></div>
      </Card.Content>
    </Card>}
    {tested && <div role="status"><Notice tone="success" title={t('testOk', { kind: tested.product.fullName, hosts: tested.counts.hosts, vms: tested.counts.vms })}/></div>}

    {/* One action at a time: test first; "Save" replaces it once this exact form passed (any change tests again). */}
    <div className="flex flex-wrap justify-end gap-2">
      {tested && testedFor === JSON.stringify(body())
        ? <Button type="submit" isPending={busy === 'save'} isDisabled={!!busy}><I name="check" size={16}/>{t('save')}</Button>
        : <Button type="button" isPending={busy === 'test'} isDisabled={!!busy} onPress={() => test(form)}>
          <I name="plug-zap" size={16}/>{busy === 'test' ? t('working') : t('test')}</Button>}
    </div>
  </form>;
}
