"use client";
// Settings → Directory → Single sign-on: an OpenID Connect provider (issuer, client, scopes), which roles its
// groups give, and a check that reads the provider's discovery document. Sign-in itself is the API's (sso.ts).
import { Button, Card, Chip, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../../components/icon';
import { GuideButton } from '../../../../components/setup-guide';
import { CheckboxInput, FormActions, FormSection, Notice, SelectInput, SwitchInput, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';
import { GroupRoleList } from './directory';

type Oidc = { enabled: boolean; name: string; issuer: string; clientId: string; scopes: string; groupsClaim: string; groupRoles: { group: string; roles: string[] }[];
  defaultRole: string; autoCreate: boolean; clientSecretSet: boolean };
type Doc = { oidc: Oidc; ssoUsers: number };

export default function SsoSettings({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.directory');
  const ts = useTranslations('Settings');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<Doc>(['settings', 'directory'], '/admin/settings/directory');
  const roleList = useApiQuery<{ roles: { key: string; name: string }[] }>(['admin', 'roles'], '/admin/roles').data?.roles ?? [];
  const [v, setV] = useState<Oidc | null>(null);
  const [secret, setSecret] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; detail?: string; claims?: string[] }>();
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);
  useEffect(() => { if (q.data && !v) setV(q.data.oidc); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v || !q.data) return null;
  const set = <K extends keyof Oidc>(k: K) => (x: Oidc[K]) => { setV({ ...v, [k]: x }); setFields((f) => ({ ...f, [k]: '' })); };
  const err = (k: string) => field(fields[k]);
  const body = () => ({ oidc: { ...v, clientSecret: secret } });

  async function save() {
    setBusy(true); setFields({});
    try { const r = await apiFetch<Doc>('/admin/settings/directory/sso', { method: 'PUT', body: body() }); client.setQueryData(['settings', 'directory'], r); setV(r.oidc); setSecret(''); toast.success(ts('saved')); }
    catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  async function test() {
    setTesting(true); setResult(undefined);
    try {
      const r = await apiFetch<{ issuer: string; claims: string[] }>('/admin/settings/directory/sso/test', { method: 'POST', body: body() });
      setResult({ ok: true, text: t('ssoTestOk', { issuer: r.issuer }), claims: r.claims });
    } catch (e) { setFields((e as ApiError).fields ?? {}); setResult({ ok: false, text: error(e), detail: (e as { detail?: string }).detail }); }
    finally { setTesting(false); }
  }

  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('ssoTitle')} description={t('ssoIntro')} icon={<I name="building-2" size={16}/>} aside={<GuideButton id="oidc"/>}>
      <SwitchInput label={t('ssoEnabled')} isSelected={v.enabled} onChange={set('enabled')} isDisabled={readOnly}/>
      {q.data.ssoUsers > 0 && <p className="text-sm text-muted">{t('ssoUsers', { n: q.data.ssoUsers })}</p>}
      <Notice tone="default">{t('ssoHow')}</Notice>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput maxLength={40} label={t('ssoName')} value={v.name} onChange={set('name')} help={t('ssoNameHelp')} isDisabled={readOnly}/>
        <TextInput label={t('issuer')} value={v.issuer} onChange={set('issuer')} placeholder="https://id.example.com/realms/main" error={err('issuer')} isDisabled={readOnly} spellCheck={false}
          help={t('issuerHelp', { issuer: v.issuer || 'https://…' })}/>
        <TextInput maxLength={300} label={t('clientId')} value={v.clientId} onChange={set('clientId')} error={err('clientId')} isDisabled={readOnly} spellCheck={false}/>
        <TextInput label={t('clientSecret')} type="password" value={secret} onChange={setSecret} placeholder={v.clientSecretSet ? ts('secretKept') : ''} error={err('clientSecret')} isDisabled={readOnly}/>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{t('redirect')}</span>
        <code className="break-all rounded-lg bg-default px-3 py-2 font-mono text-xs">{origin}/api/auth/callback/oidc</code>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput maxLength={300} label={t('scopes')} value={v.scopes} onChange={set('scopes')} error={err('scopes')} help={t('scopesHelp')} isDisabled={readOnly} spellCheck={false}/>
        <TextInput maxLength={100} label={t('groupsClaim')} value={v.groupsClaim} onChange={set('groupsClaim')} error={err('groupsClaim')} help={t('groupsClaimHelp')} isDisabled={readOnly} spellCheck={false}/>
      </div>
      <CheckboxInput label={t('ssoAutoCreate')} help={t('ssoAutoCreateHelp')} isSelected={v.autoCreate} onChange={set('autoCreate')} isDisabled={readOnly}/>
    </FormSection>
    <FormSection title={t('roles')} description={t('rolesHelp')} icon={<I name="shield-check" size={16}/>}>
      <SelectInput label={t('defaultRole')} value={v.defaultRole} onChange={(x) => set('defaultRole')(x)} isDisabled={readOnly} error={err('defaultRole')}
        options={roleList.map((r) => ({ id: r.key, label: r.name }))}/>
      <GroupRoleList mapping={v.groupRoles} onChange={set('groupRoles')} roles={roleList} readOnly={readOnly} error={err('groupRoles')} placeholder="panel-admins" groupLabel={t('ssoGroup')}/>
    </FormSection>
    {!readOnly && <FormSection title={t('ssoTest')} icon={<I name="flask-conical" size={16}/>}>
      <div><Button variant="secondary" isPending={testing} isDisabled={!v.issuer} onPress={test}><I name="flask-conical" size={16}/>{t('ssoTest')}</Button></div>
      {result && <Notice tone={result.ok ? 'success' : 'danger'} title={result.text}>
        {result.detail && <code className="break-all text-xs">{result.detail}</code>}
        {!!result.claims?.length && <div className="mt-2 flex flex-wrap items-center gap-1 text-xs"><span className="text-muted">{t('ssoClaims')}:</span>
          {result.claims.map((c) => <Chip key={c} size="sm" variant="soft">{c}</Chip>)}</div>}
      </Notice>}
    </FormSection>}
    {!readOnly && <FormActions><Button isPending={busy} onPress={save}><I name="check" size={16}/>{t('ssoSave')}</Button></FormActions>}
  </Card.Content></Card>;
}
