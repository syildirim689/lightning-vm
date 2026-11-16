"use client";
// Settings → API: who may create tokens and under which rules (lifetime, rate limit, addresses, request log),
// every token of every account with a revoke, the request log, and the way to the reference and its PDF.
import { fold } from '../../../../lib/search';
import { Button, Card, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../../components/icon';
import { ButtonLink, ConfirmButton, DataTable, Empty, FormActions, FormSection, Mono, NumberInput, Notice, Stat, StatusChip, SwitchInput, TextInput, Loading } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { useApiAction, useApiQuery } from '../../../../lib/query';
import { MethodBadge } from '../../api-docs/reference';

type Rules = { who: 'everyone' | 'staff' | 'off'; maxDays: number; staffExpiry: boolean; rateLimit: number; networks: string[]; log: boolean; logDays: number };
type Token = { id: string; name: string; hint: string; scope: 'read' | 'write'; permissions: string[] | null; allowedIps: string[]; expiresAt: string | null; lastUsedAt: string | null;
  lastUsedIp: string | null; createdAt: string; owner: { id: string; email: string; name: string; role: string }; requests24h: number; errors24h: number };
type LogRow = { id: string; tokenId: string | null; tokenName: string | null; owner: string | null; method: string; route: string; path: string; status: number; durationMs: number; ip: string | null; createdAt: string };
type Log = { requests: LogRow[]; summary: { requests: number; errors: number; limited: number; avgMs: number; tokens: number }; top: { method: string; route: string; n: number }[] };

function RulesForm({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.api');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<Rules>(['settings', 'api'], '/admin/api/settings').data;
  const [v, setV] = useState<Rules | null>(null);
  const [nets, setNets] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q && !v) { setV(q); setNets(q.networks.join('\n')); } }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return <Loading of={['settings', 'api']}/>;
  async function save() {
    setBusy(true); setFields({});
    try { const out = await apiFetch<Rules>('/admin/api/settings', { method: 'PUT', body: { ...v, networks: nets.split(/[\s,]+/).filter(Boolean) } }); client.setQueryData(['settings', 'api'], out); setV(out); setNets(out.networks.join('\n')); toast.success(t('saved'));
      // "Who may create tokens" is stored with the sign-in security settings: that copy is read again.
      client.invalidateQueries({ queryKey: ['settings', 'security'] }); }
    catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  const dis = readOnly;
  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('who')} description={t('whoHelp')} icon={<I name="key-round" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label={t('who')}>
        {(['everyone', 'staff', 'off'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={v.who === k} disabled={dis} onClick={() => setV({ ...v, who: k })}
          className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors ${v.who === k ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent'}`}>
          <span className="text-sm font-semibold">{t(`whoLevel.${k}`)}</span><span className="text-xs text-muted">{t(`whoHelpLevel.${k}`)}</span></button>)}
      </div>
      {v.who === 'off' && <Notice tone="warning">{t('offWarning')}</Notice>}
    </FormSection>
    <FormSection title={t('lifetime')} description={t('lifetimeHelp')} icon={<I name="calendar-clock" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <NumberInput label={t('maxDays')} value={v.maxDays} onChange={(n) => setV({ ...v, maxDays: n ?? 0 })} minValue={0} maxValue={3650} isDisabled={dis} error={field(fields.maxDays)}
          help={v.maxDays ? t('maxDaysOn', { n: v.maxDays }) : t('maxDaysOff')}/>
        <SwitchInput label={t('staffExpiry')} isSelected={v.staffExpiry} onChange={(x) => setV({ ...v, staffExpiry: x })} isDisabled={dis}/>
      </div>
    </FormSection>
    <FormSection title={t('rate')} description={t('rateHelp')} icon={<I name="gauge" size={16}/>}>
      <NumberInput className="max-w-xs" label={t('rateLimit')} value={v.rateLimit} onChange={(n) => setV({ ...v, rateLimit: n ?? 0 })} minValue={0} maxValue={100000} step={60}
        isDisabled={dis} error={field(fields.rateLimit)} help={v.rateLimit ? t('rateOn', { n: v.rateLimit, perSecond: Math.round((v.rateLimit / 60) * 10) / 10 }) : t('rateOff')}/>
    </FormSection>
    <FormSection title={t('networks')} description={t('networksHelp')} icon={<I name="network" size={16}/>}>
      <TextInput format="ipOrCidr" list multiline label={t('networksLabel')} value={nets} onChange={setNets} isDisabled={dis} placeholder={'203.0.113.0/24\n2001:db8::/48'} spellCheck={false}
        error={field(fields.networks)} help={nets.trim() ? t('networksOn', { n: nets.split(/[\s,]+/).filter(Boolean).length }) : t('networksOff')}/>
    </FormSection>
    <FormSection title={t('logTitle')} description={t('logHelp')} icon={<I name="scroll-text" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
        <SwitchInput label={t('logOn')} isSelected={v.log} onChange={(x) => setV({ ...v, log: x })} isDisabled={dis}/>
        <NumberInput label={t('logDays')} value={v.logDays} onChange={(n) => setV({ ...v, logDays: n ?? 14 })} minValue={1} maxValue={365} isDisabled={dis || !v.log} error={field(fields.logDays)}/>
      </div>
    </FormSection>
    {!readOnly && <FormActions><Button isPending={busy} onPress={save}><I name="check" size={16}/>{t('save')}</Button></FormActions>}
  </Card.Content></Card>;
}

function Tokens({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.api');
  const format = useFormatter();
  const list = useApiQuery<{ tokens: Token[] }>(['admin', 'api-tokens'], '/admin/api/tokens').data?.tokens;
  const [needle, setNeedle] = useState('');
  const revoke = useApiAction((id: string) => apiFetch(`/admin/api/tokens/${id}`, { method: 'DELETE' }), { invalidate: [['admin', 'api-tokens']], success: t('revoked') });
  const ago = (d: string) => format.relativeTime(new Date(Math.min(Date.parse(d), Date.now())), new Date());
  const rows = (list ?? []).filter((x) => !needle || fold(`${x.name} ${x.owner.email} ${x.owner.name}`).includes(fold(needle)));
  const now = Date.now();
  return <Card id="api-tokens"><Card.Header>
    <Card.Title className="flex items-center gap-2"><I name="key-round" size={18}/>{t('tokensTitle')}{list && <span className="text-sm font-normal text-muted">({list.length})</span>}</Card.Title>
    <Card.Description>{t('tokensHelp')}</Card.Description>
  </Card.Header><Card.Content className="flex flex-col gap-3">
    {!list ? <Loading of={['admin', 'api-tokens']}/> : list.length === 0 ? <Empty icon={<I name="key-round" size={24}/>} title={t('noTokens')}/> : <>
      {list.length > 5 && <input type="search" role="searchbox" aria-label={t('searchTokens')} placeholder={t('searchTokens')} value={needle} onChange={(e) => setNeedle(e.target.value)}
        className="w-full max-w-sm rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-accent"/>}
      <DataTable label={t('tokensTitle')} rows={rows} rowKey={(x) => x.id} minWidth={900}
        columns={[{ id: 'n', label: t('col.token') }, { id: 'o', label: t('col.owner') }, { id: 'a', label: t('col.access') }, { id: 'u', label: t('col.used') }, { id: 'r', label: t('col.today') },
          { id: 'e', label: t('col.expires') }, { id: 'x', label: <span className="sr-only">{t('revoke')}</span> }]}
        cells={(x) => [
          <span key="n" className="flex flex-col"><span className="font-medium">{x.name}</span><span className="font-mono text-xs text-muted">lvm_…{x.hint}</span></span>,
          <span key="o" className="flex min-w-0 flex-col"><span className="[overflow-wrap:anywhere]">{x.owner.email}</span><span className="text-xs text-muted">{x.owner.role}</span></span>,
          <span key="a" className="flex flex-col items-start gap-1">
            <StatusChip tone={x.scope === 'write' ? 'warning' : 'default'}>{t(`scope.${x.scope}`)}</StatusChip>
            <span className="text-xs text-muted">{x.permissions ? t('narrowed', { n: x.permissions.length }) : t('allPermissions')}{x.allowedIps.length ? ` · ${t('addresses', { n: x.allowedIps.length })}` : ''}</span></span>,
          x.lastUsedAt ? <span key="u" className="flex flex-col"><span>{ago(x.lastUsedAt)}</span>{x.lastUsedIp && <span className="font-mono text-xs text-muted">{x.lastUsedIp}</span>}</span> : <span key="u" className="text-muted">{t('never')}</span>,
          <span key="r" className="tabular-nums">{x.requests24h}{x.errors24h > 0 && <span className="text-danger"> · {t('errorsShort', { n: x.errors24h })}</span>}</span>,
          x.expiresAt ? (Date.parse(x.expiresAt) < now ? <StatusChip key="e" tone="danger">{t('expired')}</StatusChip> : <span key="e">{format.dateTime(new Date(x.expiresAt), { dateStyle: 'medium' })}</span>)
            : <span key="e" className="text-warning">{t('noExpiry')}</span>,
          readOnly ? null : <ConfirmButton key="x" size="sm" variant="danger-soft" icon={<I name="ban" size={14}/>} label={<span className="sr-only sm:not-sr-only">{t('revoke')}</span>}
            title={t('revokeTitle', { name: x.name, owner: x.owner.email })} body={t('revokeBody')} confirmLabel={t('revoke')} cancelLabel={t('cancel')} onConfirm={() => revoke.mutate(x.id)}/>]}/>
    </>}
  </Card.Content></Card>;
}

function RequestLog() {
  const t = useTranslations('Settings.api');
  const format = useFormatter();
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [needle, setNeedle] = useState('');
  const path = `/admin/api/log?limit=200${errorsOnly ? '&status=errors' : ''}${needle.trim() ? `&q=${encodeURIComponent(needle.trim())}` : ''}`;
  const q = useApiQuery<Log>(['admin', 'api-log', errorsOnly, needle.trim()], path, { refetchInterval: 30_000 });
  const d = q.data;
  return <Card id="api-log"><Card.Header>
    <Card.Title className="flex items-center gap-2"><I name="scroll-text" size={18}/>{t('logTitle')}</Card.Title>
    <Card.Description>{t('logIntro')}</Card.Description>
  </Card.Header><Card.Content className="flex flex-col gap-4">
    {d && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label={t('sum.requests')} value={d.summary.requests} icon={<I name="activity" size={18}/>} hint={t('sum.tokens', { n: d.summary.tokens })}/>
      <Stat label={t('sum.errors')} value={d.summary.errors} tone={d.summary.errors ? 'danger' : 'success'} icon={<I name="triangle-alert" size={18}/>}
        hint={d.summary.requests ? t('sum.rate', { pct: Math.round((d.summary.errors / d.summary.requests) * 100) }) : undefined}
        pressed={errorsOnly} onPress={() => setErrorsOnly(!errorsOnly)}/>
      <Stat label={t('sum.limited')} value={d.summary.limited} tone={d.summary.limited ? 'warning' : 'default'} icon={<I name="gauge" size={18}/>}/>
      <Stat label={t('sum.avg')} value={`${d.summary.avgMs} ms`} icon={<I name="timer" size={18}/>}/>
    </div>}
    {!!d?.top.length && <div className="flex flex-col gap-1.5">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">{t('top')}</h4>
      <ul className="flex flex-col gap-1">{d.top.map((r) => <li key={r.method + r.route} className="flex items-center gap-2 text-sm">
        <MethodBadge method={r.method}/><code className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:anywhere]">{r.route}</code><span className="tabular-nums text-muted">{r.n}</span></li>)}</ul>
    </div>}
    <div className="flex flex-wrap items-center gap-3">
      <input type="search" role="searchbox" aria-label={t('searchLog')} placeholder={t('searchLog')} value={needle} onChange={(e) => setNeedle(e.target.value)}
        className="w-full max-w-sm rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-accent"/>
      <SwitchInput label={t('errorsOnly')} isSelected={errorsOnly} onChange={setErrorsOnly}/>
    </div>
    {!d ? <Loading of={['admin', 'api-log', errorsOnly, needle.trim()]}/> : d.requests.length === 0 ? <Empty icon={<I name="scroll-text" size={24}/>} title={t('logEmpty')}/>
      : <DataTable label={t('logTitle')} rows={d.requests} rowKey={(r) => r.id} minWidth={820}
        columns={[{ id: 'w', label: t('col.when') }, { id: 'r', label: t('col.request') }, { id: 's', label: t('col.status') }, { id: 'd', label: t('col.duration') }, { id: 'k', label: t('col.token') }, { id: 'i', label: t('col.ip') }]}
        cells={(r) => [
          <span key="w" className="whitespace-nowrap" title={format.dateTime(new Date(r.createdAt), { dateStyle: 'medium', timeStyle: 'medium' })}>{format.dateTime(new Date(r.createdAt), { timeStyle: 'medium' })}</span>,
          <span key="r" className="flex min-w-0 items-center gap-2"><MethodBadge method={r.method}/><code className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]" title={r.route}>{r.path}</code></span>,
          <StatusChip key="s" tone={r.status >= 500 ? 'danger' : r.status >= 400 ? 'warning' : 'success'}>{r.status}</StatusChip>,
          <span key="d" className="tabular-nums">{r.durationMs} ms</span>,
          <span key="k" className="flex flex-col"><span>{r.tokenName ?? '–'}</span><span className="text-xs text-muted [overflow-wrap:anywhere]">{r.owner ?? ''}</span></span>,
          <Mono key="i">{r.ip ?? '–'}</Mono>]}/>}
  </Card.Content></Card>;
}

export default function ApiSettings({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.api');
  return <div className="flex flex-col gap-5">
    <Card><Card.Content className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3"><span aria-hidden className="rounded-lg bg-accent-soft p-2 text-accent"><I name="book-open" size={20}/></span>
        <div><p className="font-semibold">{t('docsTitle')}</p><p className="text-sm text-muted">{t('docsHelp')}</p></div></div>
      <div className="flex flex-wrap gap-2">
        <ButtonLink href="/api-docs"><I name="book-open" size={16}/>{t('openDocs')}</ButtonLink>
        <ButtonLink href="/account?tab=api" variant="secondary"><I name="key-round" size={16}/>{t('myTokens')}</ButtonLink>
      </div>
    </Card.Content></Card>
    <RulesForm readOnly={readOnly}/>
    <Tokens readOnly={readOnly}/>
    <RequestLog/>
  </div>;
}
