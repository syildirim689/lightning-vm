"use client";
// Settings → Reverse DNS: the PowerDNS server that holds the reverse zones of the routed blocks, the default
// PTR of new servers, and what customers may change. The test lists the reverse zones and which IP pools they cover.
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../../components/icon';
import { FormActions, FormSection, Mono, Notice, NumberInput, SelectInput, StatusChip, SwitchInput, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Rdns = { provider: 'none' | 'powerdns'; apiUrl: string; apiKeySet: boolean; serverId: string; template: string; ttl: number; customerEdit: boolean; forwardCheck: boolean };
type TestResult = { version: string; zones: string[]; pools: { name: string; ipv4: boolean; ipv6: boolean | null }[] };

const preview = (template: string) => template.replaceAll('{ip-dashed}', '203-0-113-10').replaceAll('{ip}', '203.0.113.10').replaceAll('{name}', 'web-1').toLowerCase();

export default function ReverseDns({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.rdns');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<Rdns>(['admin', 'settings', 'rdns'], '/admin/settings/rdns');
  const [v, setV] = useState<Rdns & { apiKey: string }>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('');
  const [result, setResult] = useState<TestResult>();
  useEffect(() => { if (q.data && !v) setV({ ...q.data, apiKey: '' }); }, [q.data, v]);
  if (!v) return <p role="status" className="text-sm text-muted">{q.error ? error(q.error) : t('loading')}</p>;
  const set = (patch: Partial<typeof v>) => setV({ ...v, ...patch });

  async function save() {
    setBusy('save'); setFields({});
    try { const out = await apiFetch<Rdns>('/admin/settings/rdns', { method: 'PUT', body: v }); setV({ ...out, apiKey: '' }); toast.success(t('saved')); client.invalidateQueries({ queryKey: ['admin', 'settings', 'rdns'] }); }
    catch (e) { setFields((e as { fields?: Record<string, string> }).fields ?? {}); toast.danger(error(e)); } finally { setBusy(''); }
  }
  async function test() {
    setBusy('test'); setResult(undefined); setFields({});
    try { setResult(await apiFetch<TestResult>('/admin/settings/rdns/test', { method: 'POST', body: v })); }
    catch (e) { setFields((e as { fields?: Record<string, string> }).fields ?? {}); toast.danger(error(e)); } finally { setBusy(''); }
  }
  const on = v.provider === 'powerdns';

  return <div className="flex flex-col">
    <FormSection title={t('providerTitle')} description={t('providerHelp')} icon={<I name="globe" size={18}/>}>
      <SelectInput label={t('provider')} value={v.provider} onChange={(x) => set({ provider: (x || 'none') as Rdns['provider'] })} isDisabled={readOnly}
        options={[{ id: 'none', label: t('providers.none') }, { id: 'powerdns', label: 'PowerDNS (HTTP API)', description: t('providers.powerdns') }]}/>
      {on && <div className="grid gap-4 sm:grid-cols-2">
        <TextInput label={t('apiUrl')} value={v.apiUrl} onChange={(x) => set({ apiUrl: x })} placeholder="http://10.0.0.53:8081" help={t('apiUrlHelp')} error={field(fields.apiUrl)} isDisabled={readOnly} spellCheck={false}/>
        <TextInput label={t('apiKey')} type="password" value={v.apiKey} onChange={(x) => set({ apiKey: x })} placeholder={v.apiKeySet ? t('secretSet') : ''} error={field(fields.apiKey)} isDisabled={readOnly} autoComplete="off"/>
        <TextInput label={t('serverId')} value={v.serverId} onChange={(x) => set({ serverId: x })} help={t('serverIdHelp')} isDisabled={readOnly} spellCheck={false}/>
        <NumberInput label="TTL" value={v.ttl} onChange={(x) => set({ ttl: x ?? 3600 })} minValue={60} maxValue={86400} help={t('ttlHelp')} error={field(fields.ttl)} isDisabled={readOnly}/>
      </div>}
    </FormSection>
    {on && <FormSection title={t('defaultsTitle')} description={t('defaultsHelp')} icon={<I name="sparkles" size={18}/>}>
      <TextInput label={t('template')} value={v.template} onChange={(x) => set({ template: x })} placeholder="{ip-dashed}.static.example.com" error={field(fields.template)} isDisabled={readOnly} spellCheck={false}
        help={v.template ? t('preview', { ptr: preview(v.template) }) : t('templateHelp')}/>
      <SwitchInput label={t('customerEdit')} isSelected={v.customerEdit} onChange={(x) => set({ customerEdit: x })} isDisabled={readOnly}/>
      <SwitchInput label={t('forwardCheck')} isSelected={v.forwardCheck} onChange={(x) => set({ forwardCheck: x })} isDisabled={readOnly || !v.customerEdit}/>
      <p className="text-xs text-muted">{t('forwardHelp')}</p>
    </FormSection>}
    {result && <FormSection title={t('resultTitle')} description={t('resultHelp', { version: result.version })} icon={<I name="plug-zap" size={18}/>}>
      {result.zones.length === 0 ? <Notice tone="warning">{t('noZones')}</Notice>
        : <p className="flex flex-wrap gap-1 text-sm">{result.zones.map((z) => <Mono key={z}>{z}</Mono>)}</p>}
      <ul className="flex flex-col gap-1 text-sm">{result.pools.map((p) => <li key={p.name} className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.name}</span>
        <StatusChip tone={p.ipv4 ? 'success' : 'danger'}>IPv4 · {p.ipv4 ? t('covered') : t('missing')}</StatusChip>
        {p.ipv6 !== null && <StatusChip tone={p.ipv6 ? 'success' : 'danger'}>IPv6 · {p.ipv6 ? t('covered') : t('missing')}</StatusChip>}
      </li>)}</ul>
    </FormSection>}
    {!readOnly && <FormActions>
      {on && <Button variant="secondary" isPending={busy === 'test'} isDisabled={!!busy} onPress={test}><I name="plug-zap" size={16}/>{t('test')}</Button>}
      <Button isPending={busy === 'save'} isDisabled={!!busy} onPress={save}><I name="check" size={16}/>{t('save')}</Button>
    </FormActions>}
  </div>;
}
