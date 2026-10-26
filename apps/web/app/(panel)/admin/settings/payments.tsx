"use client";
// Settings → Payments: every Turkish payment institution and bank virtual POS the API knows. Each provider
// keeps live and test credentials side by side (both saved); the admin checks a mode against the provider
// (no money moves) and activates it in that mode. Secrets are write-only.
import { Button, Chip, Modal, Tabs, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { I } from '../../../../components/icon';
import { ConfirmButton, Empty, FormSection, Mono, Notice, SelectInput, StatusChip, SwitchInput, TextInput, type Tone } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Mode = 'live' | 'test';
type Field = { key: string; label: [string, string]; secret?: boolean; optional?: boolean; unverifiable?: boolean };
type Provider = { id: string; name: string; kind: 'gateway' | 'bank' | 'wallet' | 'international'; platform: string; website: string; docs: string; confidence: 'docs' | 'partial' | 'community';
  fields: Field[]; hosts: Record<Mode, string>; threeD: string[]; notes: string[]; checkable: boolean; testCredentials: Record<string, string> | null; testCards: string[] };
type CheckStatus = 'ok' | 'rejected' | 'inconclusive' | 'network' | 'unverifiable';
type Check = { status: CheckStatus; message?: string; unverified?: string[]; at: string; current: boolean };
type Side = { values: Record<string, string>; secretsSet: Record<string, boolean>; complete: boolean; configured: boolean; check: Check | null };
type Gateway = { id: string; enabled: boolean; mode: Mode; label: string; sort: number; live: Side; test: Side };
type Data = { providers: Provider[]; gateways: Gateway[] };
type TestReply = { status: CheckStatus; message?: string; unverified?: string[]; recorded: boolean; mode: Mode };

const modes: Mode[] = ['live', 'test'];
const checkTone: Record<CheckStatus, Tone> = { ok: 'success', rejected: 'danger', inconclusive: 'warning', network: 'warning', unverifiable: 'default' };

export default function Payments({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.payments');
  const q = useApiQuery<Data>(['admin', 'payments'], '/admin/settings/payments');
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const client = useQueryClient();
  const { error } = useErrorText();
  const data = q.data;
  const byId = useMemo(() => new Map((data?.gateways ?? []).map((g) => [g.id, g])), [data]);
  if (!data) return <p role="status" className="text-sm text-muted">{q.error ? error(q.error) : t('loading')}</p>;
  const fold = (s: string) => s.toLocaleLowerCase('tr');
  const list = data.providers.filter((p) => (!kind || p.kind === kind) && (!search || fold(`${p.name} ${p.platform}`).includes(fold(search))));
  const active = data.gateways.filter((g) => g.enabled).sort((a, b) => a.sort - b.sort);
  const name = (id: string) => byId.get(id)?.label || data.providers.find((p) => p.id === id)?.name || id;
  async function move(id: string, dir: -1 | 1) {
    const ids = active.map((g) => g.id);
    const i = ids.indexOf(id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    try { await apiFetch('/admin/settings/payments', { method: 'PUT', body: { order: ids } }); client.invalidateQueries({ queryKey: ['admin', 'payments'] }); }
    catch (e) { toast.danger(error(e)); }
  }

  return <div className="flex flex-col gap-6">
    <FormSection title={t('activeTitle')} description={t('activeHelp')} icon={<I name="credit-card" size={18}/>}>
      {active.length === 0 ? <Notice tone="warning">{t('noneActive')}</Notice>
        : <ol className="flex flex-col gap-2">{active.map((g, i) => <li key={g.id} className="flex items-center gap-3 rounded-xl border border-border p-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{i + 1}</span>
          <button type="button" className="min-w-0 flex-1 truncate text-left font-medium hover:underline" onClick={() => setOpen(g.id)}>{name(g.id)}</button>
          <StatusChip tone={g.mode === 'live' ? 'success' : 'warning'}>{t(`mode.${g.mode}`)}</StatusChip>
          {!readOnly && <span className="flex gap-1">
            <Button isIconOnly size="sm" variant="ghost" aria-label={t('moveUp')} isDisabled={i === 0} onPress={() => move(g.id, -1)}><I name="chevron-up" size={16}/></Button>
            <Button isIconOnly size="sm" variant="ghost" aria-label={t('moveDown')} isDisabled={i === active.length - 1} onPress={() => move(g.id, 1)}><I name="chevron-down" size={16}/></Button>
          </span>}
        </li>)}</ol>}
    </FormSection>

    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <TextInput className="min-w-56 flex-1" label={t('search')} value={search} onChange={setSearch} placeholder="iyzico, Garanti, Nestpay…"/>
        <SelectInput className="w-56" label={t('kindLabel')} value={kind} onChange={setKind}
          options={[{ id: '', label: t('kind.all') }, ...(['gateway', 'bank', 'wallet', 'international'] as const).map((k) => ({ id: k, label: t(`kind.${k}`) }))]}/>
      </div>
      <p className="text-sm text-muted">{t('count', { n: list.length })}</p>
      {list.length === 0 && <Empty icon={<I name="search" size={24}/>} title={t('nothingFound')}/>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((p, i) => {
          const g = byId.get(p.id);
          const [tone, label] = status(g);
          return <motion.button key={p.id} type="button" onClick={() => setOpen(p.id)} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 20) * 0.015 }}
            className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 text-left outline-offset-2 transition hover:-translate-y-0.5 hover:border-accent hover:shadow-lg">
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0"><span className="block truncate font-semibold">{p.name}</span><span className="block truncate text-xs text-muted">{p.platform}</span></span>
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-default text-muted"><I name={({ bank: 'landmark', wallet: 'wallet', gateway: 'credit-card', international: 'globe' } as const)[p.kind]} size={18}/></span>
            </span>
            <span className="flex flex-wrap gap-1.5">
              <StatusChip tone={tone}>{t(`state.${label}`)}</StatusChip>
              <Chip size="sm" variant="soft">{p.checkable ? t('checkable') : t('notCheckable')}</Chip>
            </span>
          </motion.button>;
        })}
      </div>
    </div>
    {open && <Editor key={open} provider={data.providers.find((p) => p.id === open)!} gateway={byId.get(open)} readOnly={readOnly} onClose={() => setOpen(null)}/>}
  </div>;
}

function status(g?: Gateway): [Tone, 'activeLive' | 'activeTest' | 'failed' | 'saved' | 'notSet'] {
  if (!g) return ['default', 'notSet'];
  if (g.enabled) return [g.mode === 'live' ? 'success' : 'warning', g.mode === 'live' ? 'activeLive' : 'activeTest'];
  if (modes.some((m) => g[m].check?.current && ['rejected', 'network'].includes(g[m].check!.status))) return ['danger', 'failed'];
  return modes.some((m) => g[m].configured) ? ['accent', 'saved'] : ['default', 'notSet'];
}

function Editor({ provider: p, gateway: g, readOnly, onClose }: { provider: Provider; gateway?: Gateway; readOnly: boolean; onClose: () => void }) {
  const t = useTranslations('Settings.payments');
  const locale = useLocale();
  const format = useFormatter();
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const blank = (m: Mode) => ({ ...Object.fromEntries(p.fields.map((f) => [f.key, f.secret ? '' : g?.[m].values[f.key] ?? ''])), endpoint: g?.[m].values.endpoint ?? '' });
  const [values, setValues] = useState<Record<Mode, Record<string, string>>>({ live: blank('live'), test: blank('test') });
  const [tab, setTab] = useState<Mode>(g?.mode ?? 'test');
  const [mode, setMode] = useState<Mode>(g?.mode ?? 'test');
  const [label, setLabel] = useState(g?.label ?? '');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'state'>('');
  const [result, setResult] = useState<Partial<Record<Mode, TestReply>>>({});
  const refresh = () => client.invalidateQueries({ queryKey: ['admin', 'payments'] });
  const touched = (m: Mode) => Object.values(values[m]).some((v) => v.trim());
  const dirty = (m: Mode) => JSON.stringify(values[m]) !== JSON.stringify(blank(m));
  const labelOf = (f: Field) => f.label[locale === 'tr' ? 0 : 1];

  async function save() {
    setBusy('save'); setFields({});
    const body: Record<string, unknown> = { mode, label };
    for (const m of modes) if (g?.[m].configured || touched(m)) body[m] = values[m];
    try {
      await apiFetch(`/admin/settings/payments/${p.id}`, { method: 'PUT', body });
      toast.success(t('saved')); refresh(); setResult({});
      setValues({ live: { ...values.live, ...Object.fromEntries(p.fields.filter((f) => f.secret).map((f) => [f.key, ''])) }, test: { ...values.test, ...Object.fromEntries(p.fields.filter((f) => f.secret).map((f) => [f.key, ''])) } });
    } catch (e) {
      const fx = (e as { fields?: Record<string, string> }).fields ?? {};
      setFields(fx);
      const first = Object.keys(fx)[0]?.split('.')[0];
      if (first === 'live' || first === 'test') setTab(first);
      toast.danger(error(e));
    } finally { setBusy(''); }
  }
  async function test(m: Mode) {
    setBusy('test');
    try { setResult((r) => ({ ...r, [m]: undefined })); const out = await apiFetch<TestReply>(`/admin/settings/payments/${p.id}/test`, { method: 'POST', body: { mode: m, credentials: values[m] } }); setResult((r) => ({ ...r, [m]: out })); refresh(); }
    catch (e) { setFields((e as { fields?: Record<string, string> }).fields ?? {}); toast.danger(error(e)); } finally { setBusy(''); }
  }
  async function activate(on: boolean) {
    setBusy('state');
    try { await apiFetch(`/admin/settings/payments/${p.id}/state`, { method: 'POST', body: { enabled: on, mode } }); toast.success(on ? t('activated', { mode: t(`mode.${mode}`) }) : t('deactivated')); refresh(); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(''); }
  }
  async function remove() {
    try { await apiFetch(`/admin/settings/payments/${p.id}`, { method: 'DELETE' }); toast.success(t('removed')); refresh(); onClose(); }
    catch (e) { toast.danger(error(e)); throw e; }
  }

  const side = (m: Mode) => {
    const saved = g?.[m];
    const r = result[m];
    const last = saved?.check;
    return <div className="flex flex-col gap-4">
      {m === 'live' ? <Notice tone="warning">{t('liveWarning')}</Notice> : <Notice>{t('testHelp')}</Notice>}
      {m === 'test' && p.testCredentials && !readOnly && <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button size="sm" variant="secondary" onPress={() => setValues((v) => ({ ...v, test: { ...v.test, ...p.testCredentials! } }))}><I name="sparkles" size={14}/>{t('fillTest')}</Button>
        <span className="text-xs text-muted">{t('fillTestHelp')}</span>
      </div>}
      <div className="grid gap-4 sm:grid-cols-2">
        {p.fields.map((f) => <div key={f.key} className="flex flex-col gap-1">
          <TextInput label={`${labelOf(f)}${f.optional ? ` (${t('optional')})` : ''}`} type={f.secret ? 'password' : 'text'} value={values[m][f.key] ?? ''} isDisabled={readOnly}
            onChange={(v) => setValues((x) => ({ ...x, [m]: { ...x[m], [f.key]: v } }))} autoComplete="off" spellCheck={false}
            placeholder={f.secret && saved?.secretsSet[f.key] ? t('secretSet') : undefined} error={field(fields[`${m}.${f.key}`])}/>
          <span className="flex flex-wrap items-center gap-1 text-xs text-muted"><Mono>{f.key}</Mono>{f.unverifiable && <span className="text-warning">· {t('only3d')}</span>}</span>
        </div>)}
      </div>
      <details className="rounded-xl border border-border p-3 text-sm">
        <summary className="cursor-pointer font-medium">{t('advanced')}</summary>
        <div className="mt-3 flex flex-col gap-2">
          <TextInput label={t('endpoint')} value={values[m].endpoint ?? ''} onChange={(v) => setValues((x) => ({ ...x, [m]: { ...x[m], endpoint: v } }))} isDisabled={readOnly}
            placeholder={p.hosts[m]} help={t('endpointHelp')} error={field(fields[`${m}.endpoint`])} spellCheck={false}/>
          {m === 'test' && p.testCards.length > 0 && <p className="text-xs text-muted">{t('testCards')}: {p.testCards.map((c) => <Mono key={c}>{c}</Mono>)}</p>}
        </div>
      </details>
      <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">{t('checkTitle')}</p>
          {!readOnly && <Button size="sm" variant="secondary" isPending={busy === 'test'} isDisabled={!!busy} onPress={() => test(m)}><I name="plug-zap" size={14}/>{t('runCheck', { mode: t(`mode.${m}`) })}</Button>}
        </div>
        <p className="text-xs text-muted">{p.checkable ? t('checkHow') : t('checkNone')}</p>
        {r && <CheckView check={r} fields={p.fields} labelOf={labelOf}/>}
        {r && !r.recorded && <p className="text-xs text-warning">{t('notRecorded')}</p>}
        {!r && last && <div className="flex flex-col gap-1">
          <p className="text-xs text-muted">{t('lastCheck', { time: format.dateTime(new Date(last.at), { dateStyle: 'medium', timeStyle: 'short' }) })}{!last.current && ` · ${t('outdated')}`}</p>
          <CheckView check={last} fields={p.fields} labelOf={labelOf}/>
        </div>}
      </div>
      {dirty(m) && <p className="text-xs text-warning">{t('unsaved')}</p>}
    </div>;
  };

  return <Modal.Backdrop isOpen onOpenChange={(o) => { if (!o) onClose(); }}>
    <Modal.Container size="lg" scroll="inside">
      <Modal.Dialog>
        <Modal.CloseTrigger/>
        <Modal.Header className="flex flex-col items-start gap-1">
          <Modal.Heading>{p.name}</Modal.Heading>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{p.platform}</span>·<a className="text-accent hover:underline" href={p.website} target="_blank" rel="noreferrer">{t('website')}</a>·
            <a className="text-accent hover:underline" href={p.docs} target="_blank" rel="noreferrer">{t('docs')}</a>·<span>{t(`confidence.${p.confidence}`)}</span>
          </p>
        </Modal.Header>
        <Modal.Body className="flex flex-col gap-5">
          {p.notes.map((n) => <Notice key={n} tone={n === 'NO_SERVER_CHECK' || n === 'TOKEN_ROTATES' ? 'warning' : 'default'}>{t(`notes.${n as 'FIXED_IP'}`)}</Notice>)}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput label={t('label')} value={label} onChange={setLabel} placeholder={p.name} help={t('labelHelp')} isDisabled={readOnly} maxLength={60}/>
            <SelectInput label={t('useMode')} value={mode} onChange={(v) => setMode((v || 'test') as Mode)} isDisabled={readOnly} help={t('useModeHelp')}
              options={modes.map((m) => ({ id: m, label: t(`mode.${m}`), description: g?.[m].complete ? t('modeReady') : t('modeMissing') }))}/>
          </div>
          <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(k as Mode)}>
            <Tabs.ListContainer><Tabs.List aria-label={t('credentials')}>
              {modes.map((m) => <Tabs.Tab key={m} id={m} className="gap-2">
                <span className={`size-2 rounded-full ${g?.[m].complete ? 'bg-success' : g?.[m].configured ? 'bg-warning' : 'bg-default'}`} aria-hidden/>{t(`credentialsFor.${m}`)}<Tabs.Indicator/>
              </Tabs.Tab>)}
            </Tabs.List></Tabs.ListContainer>
            {modes.map((m) => <Tabs.Panel key={m} id={m} className="pt-4">{side(m)}</Tabs.Panel>)}
          </Tabs>
          <p className="text-xs text-muted">{t('threeD')}: {p.threeD.join(' · ')}</p>
        </Modal.Body>
        <Modal.Footer className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {!readOnly && !g && <p className="text-xs text-muted">{t('saveFirst')}</p>}
            {!readOnly && g && <SwitchInput label={g.enabled ? t('activeIn', { mode: t(`mode.${g.mode}`) }) : t('inactive')} isSelected={g.enabled} isDisabled={!!busy} onChange={activate}/>}
            {!readOnly && g && <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={t('remove')} title={t('removeTitle', { name: p.name })} body={t('removeBody')}
              confirmLabel={t('remove')} cancelLabel={t('cancel')} onConfirm={remove}/>}
          </div>
          <div className="flex gap-2">
            <Button variant="tertiary" onPress={onClose}>{t('close')}</Button>
            {!readOnly && <Button isPending={busy === 'save'} isDisabled={!!busy} onPress={save}><I name="check" size={16}/>{t('save')}</Button>}
          </div>
        </Modal.Footer>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}

function CheckView({ check, fields, labelOf }: { check: { status: CheckStatus; message?: string; unverified?: string[] }; fields: Field[]; labelOf: (f: Field) => string }) {
  const t = useTranslations('Settings.payments');
  const names = (check.unverified ?? []).map((k) => { const f = fields.find((x) => x.key === k); return f ? labelOf(f) : k; });
  return <div className="flex flex-col gap-1.5 text-sm" role="status">
    <span className="flex flex-wrap items-center gap-2"><StatusChip tone={checkTone[check.status]}>{t(`check.${check.status}`)}</StatusChip><span className="text-muted">{t(`checkExplain.${check.status}`)}</span></span>
    {check.message && <p className="break-words rounded-lg bg-default/60 px-2 py-1 font-mono text-xs">{check.message}</p>}
    {names.length > 0 && <p className="text-xs text-warning">{t('unverified', { fields: names.join(', ') })}</p>}
  </div>;
}
