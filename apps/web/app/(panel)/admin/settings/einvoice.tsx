"use client";
// Settings → e-Invoice: the GİB integrator that issues paid invoices as e-Fatura or e-Arşiv, its account (secrets are
// write-only), test or live, the two number series and the e-Fatura scenario, with a check that issues nothing.
import { Button, Card, toast } from '@heroui/react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../../components/icon';
import { Ago, FormActions, FormSection, Notice, SelectInput, StatusChip, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Field = { key: string; label: [string, string]; secret?: boolean; optional?: boolean };
type Integrator = { id: string; name: string; website: string; docs: string; verified: string[]; fields: Field[]; hosts: { test: string; live: string } };
type Doc = { provider: string; mode: 'test' | 'live'; values: Record<string, string>; secretsSet: Record<string, boolean>; efaturaSeries: string; earsivSeries: string;
  profile: 'TEMELFATURA' | 'TICARIFATURA'; senderAlias: string; check: { ok: boolean; message: string; at: string } | null; integrators: Integrator[] };

export default function EinvoiceSettings({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.einvoice');
  const locale = useLocale();
  const format = useFormatter();
  const { error, field } = useErrorText();
  const q = useApiQuery<Doc>(['settings', 'einvoice'], '/admin/settings/einvoice').data;
  const [v, setV] = useState<Doc | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  useEffect(() => { if (q && !v) setV(q); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return <p role="status" className="text-sm text-muted">…</p>;
  const p = v.integrators.find((x) => x.id === v.provider);
  const label = (f: Field) => (locale === 'tr' ? f.label[0] : f.label[1]);
  async function save() {
    setBusy('save'); setErrors({});
    try {
      const r = await apiFetch<Doc>('/admin/settings/einvoice', { method: 'PUT', body: { provider: v!.provider, mode: v!.mode, values: { ...v!.values, ...secrets }, efaturaSeries: v!.efaturaSeries,
        earsivSeries: v!.earsivSeries, profile: v!.profile, senderAlias: v!.senderAlias } });
      setV(r); setSecrets({}); toast.success(t('saved'));
    } catch (e) { const f = (e as { fields?: Record<string, string> }).fields ?? {}; setErrors(Object.fromEntries(Object.entries(f).map(([k, c]) => [k, field(c) ?? c]))); toast.danger(Object.keys(f).length ? t('fixFields') : error(e)); }
    finally { setBusy(null); }
  }
  async function test() {
    setBusy('test');
    try { const r = await apiFetch<{ check: Doc['check'] }>('/admin/settings/einvoice/test', { method: 'POST' }); setV({ ...v!, check: r.check }); if (r.check?.ok) toast.success(t('testOk')); else toast.danger(t('testFailed')); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(null); }
  }
  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('integrator')} description={t('integratorHelp')} icon={<I name="file-check-2" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectInput label={t('provider')} value={v.provider} isDisabled={readOnly} error={errors.provider}
          onChange={(x) => setV({ ...v, provider: x, values: {}, check: null })} options={[{ id: 'none', label: t('none') }, ...v.integrators.map((x) => ({ id: x.id, label: x.id === 'sandbox' ? t('sandbox') : x.name }))]}/>
        {v.provider !== 'none' && v.provider !== 'sandbox' && <SelectInput label={t('mode')} value={v.mode} isDisabled={readOnly} onChange={(x) => setV({ ...v, mode: x as Doc['mode'] })}
          options={[{ id: 'test', label: t('test') }, { id: 'live', label: t('live') }]}/>}
      </div>
      {p && p.id !== 'sandbox' && <div className="flex flex-wrap items-center gap-2 text-sm">
        {p.verified.length ? <StatusChip tone="success">{t('verified', { what: p.verified.map((k) => (k === 'earsiv' ? 'e-Arşiv' : 'e-Fatura')).join(', ') })}</StatusChip>
          : <StatusChip tone="warning">{t('unverified')}</StatusChip>}
        <a href={p.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">{t('docs')}<I name="external-link" size={12}/></a>
      </div>}
      {p?.id === 'sandbox' && <Notice tone="warning">{t('sandboxHelp')}</Notice>}
      {v.provider === 'none' && <Notice tone="default">{t('noneHelp')}</Notice>}
      {p && p.fields.length > 0 && <div className="grid gap-3 sm:grid-cols-2">
        {p.fields.map((f) => f.secret
          ? <TextInput revealable key={f.key} label={label(f)} type="password" value={secrets[f.key] ?? ''} onChange={(x) => setSecrets({ ...secrets, [f.key]: x })} isDisabled={readOnly} error={errors[`values.${f.key}`]}
              placeholder={v.secretsSet[f.key] ? t('secretKept') : ''} isRequired={!f.optional} autoComplete="off"/>
          : <TextInput key={f.key} label={label(f)} value={v.values[f.key] ?? ''} onChange={(x) => setV({ ...v, values: { ...v.values, [f.key]: x } })} isDisabled={readOnly} error={errors[`values.${f.key}`]} isRequired={!f.optional} autoComplete="off"/>)}
        <div className="sm:col-span-2"><TextInput label={t('endpoint')} value={v.values.endpoint ?? ''} onChange={(x) => setV({ ...v, values: { ...v.values, endpoint: x } })} isDisabled={readOnly}
          error={errors['values.endpoint']} placeholder={p.hosts[v.mode]} help={t('endpointHelp')} autoComplete="off"/></div>
      </div>}
      {v.provider !== 'none' && <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" isPending={busy === 'test'} isDisabled={readOnly} onPress={() => void test()}><I name="plug-zap" size={15}/>{t('check')}</Button>
        {v.check && <span className={`text-sm ${v.check.ok ? 'text-success' : 'text-danger'}`}>{v.check.ok ? t('checkOk', { result: v.check.message }) : v.check.message}
          <span className="ml-1 text-xs text-muted">· <Ago at={v.check.at}/></span></span>}
      </div>}
    </FormSection>
    <FormSection title={t('numbering')} description={t('numberingHelp')} icon={<I name="hash" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextInput label={t('efaturaSeries')} value={v.efaturaSeries} onChange={(x) => setV({ ...v, efaturaSeries: x.toUpperCase().slice(0, 3) })} error={errors.efaturaSeries} isDisabled={readOnly}
          help={`${v.efaturaSeries}${new Date().getFullYear()}000000001`} autoComplete="off"/>
        <TextInput label={t('earsivSeries')} value={v.earsivSeries} onChange={(x) => setV({ ...v, earsivSeries: x.toUpperCase().slice(0, 3) })} error={errors.earsivSeries} isDisabled={readOnly}
          help={`${v.earsivSeries}${new Date().getFullYear()}000000001`} autoComplete="off"/>
        <SelectInput label={t('profile')} value={v.profile} isDisabled={readOnly} onChange={(x) => setV({ ...v, profile: x as Doc['profile'] })} help={t('profileHelp')}
          options={[{ id: 'TEMELFATURA', label: t('temel') }, { id: 'TICARIFATURA', label: t('ticari') }]}/>
        <div className="sm:col-span-3"><TextInput maxLength={200} label={t('senderAlias')} value={v.senderAlias} onChange={(x) => setV({ ...v, senderAlias: x })} isDisabled={readOnly} help={t('senderAliasHelp')} placeholder="urn:mail:defaultgb@…" autoComplete="off"/></div>
      </div>
      <ul className="flex flex-col gap-1 text-xs text-muted">{(['rule1', 'rule2', 'rule3', 'rule4'] as const).map((k) => <li key={k} className="flex gap-1.5"><I name="check" size={12} className="mt-0.5 shrink-0 text-success"/>{t(k)}</li>)}</ul>
    </FormSection>
    {!readOnly && <FormActions><Button isPending={busy === 'save'} onPress={() => void save()}><I name="check" size={16}/>{t('save')}</Button></FormActions>}
  </Card.Content></Card>;
}
