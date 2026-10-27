"use client";
// Settings → Directory: sign-in with LDAP / Active Directory. The connection, how people are found, which roles
// their groups give, and a test that binds, finds a person and (with their password) signs them in.
import { Button, Card, Chip, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../../components/icon';
import { GuideButton } from '../../../../components/setup-guide';
import { CheckboxInput, FormActions, FormSection, Mono, Notice, SelectInput, SwitchInput, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Ldap = { enabled: boolean; url: string; startTls: boolean; caPem: string; bindDn: string; baseDn: string; userFilter: string; emailAttribute: string; nameAttribute: string;
  groupAttribute: string; groupRoles: { group: string; roles: string[] }[]; defaultRole: string; autoCreate: boolean; bindPasswordSet: boolean };
type Doc = { ldap: Ldap; directoryUsers: number };
type Found = { dn: string; email: string; name: string; groups: string[]; roles: string[] };

export default function DirectorySettings({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.directory');
  const ts = useTranslations('Settings');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<Doc>(['settings', 'directory'], '/admin/settings/directory');
  const roleList = useApiQuery<{ roles: { key: string; name: string }[] }>(['admin', 'roles'], '/admin/roles').data?.roles ?? [];
  const [v, setV] = useState<Ldap | null>(null);
  const [pw, setPw] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState({ email: '', password: '' });
  const [result, setResult] = useState<{ ok: boolean; text: string; detail?: string; user?: Found }>();
  const [testing, setTesting] = useState(false);
  useEffect(() => { if (q.data && !v) setV(q.data.ldap); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v || !q.data) return <p role="status" className="text-sm text-muted">…</p>;
  const set = <K extends keyof Ldap>(k: K) => (x: Ldap[K]) => { setV({ ...v, [k]: x }); setFields((f) => ({ ...f, [k]: '' })); };
  const err = (k: string) => field(fields[k]);
  const body = () => ({ ldap: { ...v, bindPassword: pw } });
  const roleName = (k: string) => roleList.find((r) => r.key === k)?.name ?? k;

  async function save() {
    setBusy(true); setFields({});
    try { const r = await apiFetch<Doc>('/admin/settings/directory', { method: 'PUT', body: body() }); client.setQueryData(['settings', 'directory'], r); setV(r.ldap); setPw(''); toast.success(ts('saved')); }
    catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  async function test() {
    setTesting(true); setResult(undefined);
    try {
      const r = await apiFetch<{ ok: true; user?: Found }>('/admin/settings/directory/test', { method: 'POST', body: { ...body(), email: probe.email, password: probe.password } });
      setResult({ ok: true, text: r.user ? (probe.password ? t('testSignedIn') : t('testFound')) : t('testBound'), user: r.user });
    } catch (e) { setFields((e as ApiError).fields ?? {}); setResult({ ok: false, text: error(e), detail: (e as { detail?: string }).detail }); }
    finally { setTesting(false); }
  }
  const mapping = v.groupRoles;
  const setMapping = (m: Ldap['groupRoles']) => set('groupRoles')(m);

  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('title')} description={t('intro')} icon={<I name="network" size={16}/>} aside={<GuideButton id="ldap"/>}>
      <SwitchInput label={t('enabled')} isSelected={v.enabled} onChange={set('enabled')} isDisabled={readOnly}/>
      {q.data.directoryUsers > 0 && <p className="text-sm text-muted">{t('users', { n: q.data.directoryUsers })}</p>}
      <Notice tone="default">{t('howItWorks')}</Notice>
    </FormSection>
    <FormSection title={t('connection')} description={t('connectionHelp')} icon={<I name="plug" size={16}/>}>
      <TextInput label={t('url')} value={v.url} onChange={set('url')} placeholder="ldaps://dc1.example.com:636" error={err('url')} isDisabled={readOnly} spellCheck={false} help={t('urlHelp')}/>
      <CheckboxInput label={t('startTls')} help={t('startTlsHelp')} isSelected={v.startTls} onChange={set('startTls')} isDisabled={readOnly || v.url.startsWith('ldaps:')}/>
      <TextInput multiline label={`${t('caPem')} (${ts('optional')})`} value={v.caPem} onChange={set('caPem')} placeholder="-----BEGIN CERTIFICATE-----" error={err('caPem')} isDisabled={readOnly} spellCheck={false} help={t('caPemHelp')}/>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput label={t('bindDn')} value={v.bindDn} onChange={set('bindDn')} placeholder="CN=svc-lightning,OU=Service,DC=example,DC=com" isDisabled={readOnly} spellCheck={false} help={t('bindDnHelp')}/>
        <TextInput label={t('bindPassword')} type="password" value={pw} onChange={setPw} placeholder={v.bindPasswordSet ? ts('secretKept') : ''} error={err('bindPassword')} isDisabled={readOnly}/>
      </div>
    </FormSection>
    <FormSection title={t('people')} description={t('peopleHelp')} icon={<I name="users" size={16}/>}>
      <TextInput label={t('baseDn')} value={v.baseDn} onChange={set('baseDn')} placeholder="DC=example,DC=com" error={err('baseDn')} isDisabled={readOnly} spellCheck={false}/>
      <TextInput label={t('userFilter')} value={v.userFilter} onChange={set('userFilter')} error={err('userFilter')} isDisabled={readOnly} spellCheck={false} help={t('userFilterHelp')}/>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextInput label={t('emailAttribute')} value={v.emailAttribute} onChange={set('emailAttribute')} error={err('emailAttribute')} isDisabled={readOnly} spellCheck={false}/>
        <TextInput label={t('nameAttribute')} value={v.nameAttribute} onChange={set('nameAttribute')} error={err('nameAttribute')} isDisabled={readOnly} spellCheck={false}/>
        <TextInput label={t('groupAttribute')} value={v.groupAttribute} onChange={set('groupAttribute')} error={err('groupAttribute')} isDisabled={readOnly} spellCheck={false}/>
      </div>
      <CheckboxInput label={t('autoCreate')} help={t('autoCreateHelp')} isSelected={v.autoCreate} onChange={set('autoCreate')} isDisabled={readOnly}/>
    </FormSection>
    <FormSection title={t('roles')} description={t('rolesHelp')} icon={<I name="shield-check" size={16}/>}>
      <SelectInput label={t('defaultRole')} value={v.defaultRole} onChange={(x) => set('defaultRole')(x)} isDisabled={readOnly} error={err('defaultRole')}
        options={roleList.map((r) => ({ id: r.key, label: r.name }))}/>
      <GroupRoleList mapping={mapping} onChange={setMapping} roles={roleList} readOnly={readOnly} error={err('groupRoles')} placeholder="CN=Panel Admins,OU=Groups,DC=example,DC=com"/>
    </FormSection>
    {!readOnly && <FormSection title={t('test')} description={t('testHelp')} icon={<I name="flask-conical" size={16}/>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput label={`${t('testEmail')} (${ts('optional')})`} type="email" value={probe.email} onChange={(x) => setProbe({ ...probe, email: x })}/>
        <TextInput label={`${t('testPassword')} (${ts('optional')})`} type="password" value={probe.password} onChange={(x) => setProbe({ ...probe, password: x })}/>
      </div>
      <div><Button variant="secondary" isPending={testing} isDisabled={!v.url} onPress={test}><I name="flask-conical" size={16}/>{t('runTest')}</Button></div>
      {result && <Notice tone={result.ok ? 'success' : 'danger'} title={result.text}>
        {result.detail && <code className="break-all text-xs">{result.detail}</code>}
        {result.user && <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted">DN</dt><dd className="break-all"><Mono>{result.user.dn}</Mono></dd>
          <dt className="text-muted">{t('nameAttribute')}</dt><dd>{result.user.name || '–'}</dd>
          <dt className="text-muted">{t('groupsFound')}</dt><dd className="break-all">{result.user.groups.length ? result.user.groups.join(' · ') : '–'}</dd>
          <dt className="text-muted">{t('rolesGiven')}</dt><dd className="flex flex-wrap gap-1">{result.user.roles.map((r) => <Chip key={r} size="sm" variant="soft" color="accent">{roleName(r)}</Chip>)}</dd>
        </dl>}
      </Notice>}
    </FormSection>}
    {!readOnly && <FormActions><Button isPending={busy} onPress={save}><I name="check" size={16}/>{ts('save')}</Button></FormActions>}
  </Card.Content></Card>;
}

export type Mapping = { group: string; roles: string[] }[];
export function GroupRoleList({ mapping, onChange: setMapping, roles: roleList, readOnly, error, placeholder, groupLabel }: { mapping: Mapping; onChange: (m: Mapping) => void;
  roles: { key: string; name: string }[]; readOnly: boolean; error?: string; placeholder: string; groupLabel?: string }) {
  const t = useTranslations('Settings.directory');
  return <>
      <ul className="flex flex-col gap-3">
        {mapping.map((m, i) => <li key={i} className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <div className="flex items-start gap-2">
            <TextInput className="flex-1" label={groupLabel ?? t('group')} value={m.group} onChange={(x) => setMapping(mapping.map((y, j) => (j === i ? { ...y, group: x } : y)))} placeholder={placeholder} isDisabled={readOnly} spellCheck={false}/>
            {!readOnly && <Button isIconOnly size="sm" variant="ghost" className="mt-6" aria-label={t('removeMapping')} onPress={() => setMapping(mapping.filter((_, j) => j !== i))}><I name="trash-2" size={15}/></Button>}
          </div>
          <div className="flex flex-wrap gap-2">{roleList.map((r) => <button key={r.key} type="button" role="checkbox" aria-checked={m.roles.includes(r.key)} disabled={readOnly}
            onClick={() => setMapping(mapping.map((y, j) => (j === i ? { ...y, roles: y.roles.includes(r.key) ? y.roles.filter((k) => k !== r.key) : [...y.roles, r.key] } : y)))}
            className={`rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent ${m.roles.includes(r.key) ? 'border-accent bg-accent/10 text-accent' : 'border-border hover:border-accent/50'}`}>{r.name}</button>)}</div>
        </li>)}
      </ul>
      {error && <p className="text-xs text-danger">{error}</p>}
      {!readOnly && <div><Button size="sm" variant="secondary" onPress={() => setMapping([...mapping, { group: '', roles: [] }])}><I name="plus" size={15}/>{t('addMapping')}</Button></div>}
  </>;
}
