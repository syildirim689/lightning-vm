"use client";
// Account → API: personal API tokens (shown once) and webhooks (signed POSTs of the person's notifications), with each
// webhook's recent deliveries and a test button.
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../components/icon';
import { CheckboxInput, ConfirmButton, DataTable, Empty, Mono, Notice, Section, SelectInput, StatusChip, TextInput } from '../../../components/ui';
import { apiFetch, type ApiError, useErrorText } from '../../../lib/api';
import { useApiQuery } from '../../../lib/query';

type Token = { id: string; name: string; hint: string; scope: 'read' | 'write'; expiresAt: string | null; lastUsedAt: string | null; lastUsedIp: string | null; createdAt: string };
type Webhook = { id: string; url: string; description: string; events: string[]; active: boolean; failures: number; createdAt: string; lastDelivery: { status: string; responseCode: number | null; at: string } | null };
type Delivery = { id: string; event: string; status: 'pending' | 'succeeded' | 'failed'; attempts: number; responseCode: number | null; error: string | null; durationMs: number | null; createdAt: string };

function Secret({ value, help }: { value: string; help: string }) {
  const t = useTranslations('Developer');
  return <Notice tone="success" title={t('copyNow')}>
    <div className="mt-2 flex flex-wrap items-center gap-2"><span className="break-all"><Mono>{value}</Mono></span>
      <Button size="sm" variant="secondary" onPress={() => { void navigator.clipboard?.writeText(value); toast.success(t('copied')); }}><I name="copy" size={14}/>{t('copy')}</Button></div>
    <p className="mt-2 text-xs">{help}</p>
  </Notice>;
}

function Tokens() {
  const t = useTranslations('Developer');
  const format = useFormatter();
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ tokens: Token[]; max: number }>(['api-tokens'], '/account/api-tokens');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'write'>('read');
  const [expires, setExpires] = useState('90');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [made, setMade] = useState<string>();
  const [busy, setBusy] = useState(false);
  const when = (d: string | null) => (d ? format.dateTime(new Date(d), { dateStyle: 'medium' }) : '–');
  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFields({});
    try {
      const out = await apiFetch<{ token: string }>('/account/api-tokens', { method: 'POST', body: { name, scope, expiresInDays: expires === 'never' ? null : Number(expires) } });
      setMade(out.token); setName(''); client.invalidateQueries({ queryKey: ['api-tokens'] });
    } catch (err) { setFields((err as ApiError).fields ?? {}); toast.danger(error(err)); } finally { setBusy(false); }
  }
  async function remove(id: string) {
    try { await apiFetch(`/account/api-tokens/${id}`, { method: 'DELETE' }); toast.success(t('tokens.removed')); client.invalidateQueries({ queryKey: ['api-tokens'] }); }
    catch (err) { toast.danger(error(err)); }
  }
  const list = q.data?.tokens ?? [];
  return <Section title={t('tokens.title')} description={t('tokens.help')}>
    <div className="flex flex-col gap-5">
      {made && <Secret value={made} help={t('tokens.usage')}/>}
      <form onSubmit={create} noValidate className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <TextInput label={t('tokens.name')} value={name} onChange={setName} maxLength={60} error={field(fields.name)} placeholder={t('tokens.namePlaceholder')}/>
        <SelectInput label={t('tokens.scope')} value={scope} onChange={(v) => setScope(v as 'read' | 'write')}
          options={[{ id: 'read', label: t('tokens.read') }, { id: 'write', label: t('tokens.write') }]}/>
        <SelectInput label={t('tokens.expires')} value={expires} onChange={setExpires}
          options={[{ id: '30', label: t('tokens.days', { n: 30 }) }, { id: '90', label: t('tokens.days', { n: 90 }) }, { id: '365', label: t('tokens.days', { n: 365 }) }, { id: 'never', label: t('tokens.never') }]}/>
        <Button type="submit" isPending={busy} isDisabled={!name.trim()}><I name="plus" size={16}/>{t('tokens.create')}</Button>
      </form>
      {list.length === 0 ? <Empty icon={<I name="key-round" size={20}/>} title={t('tokens.empty')}/>
        : <DataTable label={t('tokens.title')} rows={list} rowKey={(x) => x.id} minWidth={560}
          columns={[{ id: 'name', label: t('tokens.name') }, { id: 'scope', label: t('tokens.scope') }, { id: 'used', label: t('tokens.lastUsed') }, { id: 'expires', label: t('tokens.expires') }, { id: 'x', label: '' }]}
          cells={(x) => [<span key="n" className="flex flex-col"><span className="font-medium">{x.name}</span><span className="text-xs text-muted">lvm_…{x.hint}</span></span>,
            <StatusChip key="s" tone={x.scope === 'write' ? 'warning' : 'default'}>{t(`tokens.${x.scope}`)}</StatusChip>,
            x.lastUsedAt ? <span key="u" className="flex flex-col"><span>{when(x.lastUsedAt)}</span>{x.lastUsedIp && <span className="text-xs text-muted">{x.lastUsedIp}</span>}</span> : t('tokens.neverUsed'),
            x.expiresAt ? (new Date(x.expiresAt) < new Date() ? <StatusChip key="e" tone="danger">{t('tokens.expired')}</StatusChip> : when(x.expiresAt)) : t('tokens.never'),
            <ConfirmButton key="d" size="sm" variant="danger-soft" icon={<I name="trash-2" size={14}/>} label={<span className="sr-only sm:not-sr-only">{t('remove')}</span>}
              title={t('tokens.removeTitle', { name: x.name })} body={t('tokens.removeBody')} confirmLabel={t('remove')} cancelLabel={t('cancel')} onConfirm={() => remove(x.id)}/>]}/>}
    </div>
  </Section>;
}

function WebhookForm({ events, initial, onDone }: { events: string[]; initial?: Webhook; onDone: (secret?: string) => void }) {
  const t = useTranslations('Developer');
  const { error, field } = useErrorText();
  const [url, setUrl] = useState(initial?.url ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [all, setAll] = useState(initial ? initial.events.includes('*') : true);
  const [picked, setPicked] = useState<string[]>(initial?.events.filter((e) => e !== '*') ?? []);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFields({});
    const body = { url, description, events: all ? ['*'] : picked };
    try {
      if (initial) { await apiFetch(`/account/webhooks/${initial.id}`, { method: 'PUT', body }); onDone(); }
      else onDone((await apiFetch<{ secret: string }>('/account/webhooks', { method: 'POST', body })).secret);
    } catch (err) { setFields((err as ApiError).fields ?? {}); toast.danger(error(err)); } finally { setBusy(false); }
  }
  return <form onSubmit={save} noValidate className="flex flex-col gap-4 rounded-xl border border-border p-4">
    <div className="grid gap-3 sm:grid-cols-2">
      <TextInput label={t('webhooks.url')} value={url} onChange={setUrl} placeholder="https://example.com/hooks/lightning" type="url" error={field(fields.url)} help={t('webhooks.urlHelp')}/>
      <TextInput label={t('webhooks.description')} value={description} onChange={setDescription} maxLength={200}/>
    </div>
    <CheckboxInput label={t('webhooks.all')} isSelected={all} onChange={setAll} help={t('webhooks.allHelp')}/>
    {!all && <fieldset className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3" aria-label={t('webhooks.events')}>
      {events.map((e) => <CheckboxInput key={e} label={<span className="font-mono text-xs">{e}</span>} isSelected={picked.includes(e)}
        onChange={(on) => setPicked(on ? [...picked, e] : picked.filter((x) => x !== e))}/>)}
    </fieldset>}
    {fields.events && <p className="text-sm text-danger">{field(fields.events)}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" isPending={busy} isDisabled={!url.trim() || (!all && !picked.length)}><I name="check" size={16}/>{initial ? t('save') : t('webhooks.create')}</Button>
      {initial && <Button variant="ghost" onPress={() => onDone()}>{t('cancel')}</Button>}
    </div>
  </form>;
}

function Deliveries({ id }: { id: string }) {
  const t = useTranslations('Developer');
  const format = useFormatter();
  const q = useApiQuery<{ deliveries: Delivery[] }>(['webhook-deliveries', id], `/account/webhooks/${id}/deliveries`, { refetchInterval: 10_000 });
  const list = q.data?.deliveries ?? [];
  if (!list.length) return <p className="text-sm text-muted">{t('webhooks.noDeliveries')}</p>;
  return <DataTable label={t('webhooks.deliveries')} rows={list} rowKey={(d) => d.id} minWidth={520}
    columns={[{ id: 'when', label: t('webhooks.when') }, { id: 'event', label: t('webhooks.event') }, { id: 'status', label: t('webhooks.status') }, { id: 'detail', label: t('webhooks.detail') }]}
    cells={(d) => [format.dateTime(new Date(d.createdAt), { dateStyle: 'short', timeStyle: 'medium' }), <span key="e" className="font-mono text-xs">{d.event}</span>,
      <StatusChip key="s" tone={d.status === 'succeeded' ? 'success' : d.status === 'failed' ? 'danger' : 'accent'}>{t(`webhooks.st.${d.status}`)}</StatusChip>,
      [d.responseCode ? `HTTP ${d.responseCode}` : d.error, d.durationMs != null ? `${d.durationMs} ms` : null, d.attempts > 1 ? t('webhooks.attempts', { n: d.attempts }) : null].filter(Boolean).join(' · ')]}/>;
}

function Webhooks() {
  const t = useTranslations('Developer');
  const { error } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ webhooks: Webhook[]; events: string[]; max: number }>(['webhooks'], '/account/webhooks');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [secret, setSecret] = useState<string>();
  const refresh = () => client.invalidateQueries({ queryKey: ['webhooks'] });
  async function run(path: string, method: string, ok: string) {
    try {
      const out = await apiFetch<{ ok?: boolean; responseCode?: number | null; error?: string | null; secret?: string }>(path, { method });
      if (out?.secret) setSecret(out.secret);
      if (out?.ok === false) toast.danger(t('webhooks.testFailed', { detail: out.responseCode ? `HTTP ${out.responseCode}` : out.error ?? '' }));
      else toast.success(ok);
      refresh(); client.invalidateQueries({ queryKey: ['webhook-deliveries'] });
    } catch (err) { toast.danger(error(err)); }
  }
  const list = q.data?.webhooks ?? [];
  return <Section title={t('webhooks.title')} description={t('webhooks.help')}
    actions={!adding && list.length < (q.data?.max ?? 10) ? <Button size="sm" variant="secondary" onPress={() => setAdding(true)}><I name="plus" size={14}/>{t('webhooks.add')}</Button> : undefined}>
    <div className="flex flex-col gap-4">
      {secret && <Secret value={secret} help={t('webhooks.secretHelp')}/>}
      {adding && q.data && <WebhookForm events={q.data.events} onDone={(s) => { setAdding(false); if (s) setSecret(s); refresh(); }}/>}
      {list.length === 0 && !adding ? <Empty icon={<I name="webhook" size={20}/>} title={t('webhooks.empty')}/>
        : <ul className="flex flex-col gap-3">{list.map((w) => <li key={w.id} className="rounded-xl border border-border p-3">
          {editing === w.id && q.data ? <WebhookForm events={q.data.events} initial={w} onDone={() => { setEditing(undefined); refresh(); }}/> : <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-all font-mono text-sm">{w.url}</p>
                <p className="text-xs text-muted">{w.description || (w.events.includes('*') ? t('webhooks.allShort') : t('webhooks.count', { n: w.events.length }))}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip tone={w.active ? (w.failures ? 'warning' : 'success') : 'danger'}>{w.active ? (w.failures ? t('webhooks.failing', { n: w.failures }) : t('webhooks.on')) : t('webhooks.off')}</StatusChip>
                <Button size="sm" variant="secondary" onPress={() => run(`/account/webhooks/${w.id}/test`, 'POST', t('webhooks.testOk'))}><I name="send" size={14}/>{t('webhooks.test')}</Button>
                <Button size="sm" variant="ghost" onPress={() => setEditing(w.id)}><I name="pencil" size={14}/>{t('edit')}</Button>
                <Button size="sm" variant="ghost" onPress={() => setOpen(open === w.id ? undefined : w.id)} aria-expanded={open === w.id}><I name="history" size={14}/>{t('webhooks.deliveries')}</Button>
                <ConfirmButton size="sm" variant="ghost" icon={<I name="rotate-ccw" size={14}/>} label={t('webhooks.rotate')} title={t('webhooks.rotate')} body={t('webhooks.rotateBody')}
                  confirmLabel={t('webhooks.rotate')} cancelLabel={t('cancel')} onConfirm={() => run(`/account/webhooks/${w.id}/secret`, 'POST', t('webhooks.rotated'))}/>
                <ConfirmButton size="sm" variant="danger-soft" icon={<I name="trash-2" size={14}/>} label={t('remove')} title={t('webhooks.removeTitle')} body={w.url}
                  confirmLabel={t('remove')} cancelLabel={t('cancel')} onConfirm={() => run(`/account/webhooks/${w.id}`, 'DELETE', t('webhooks.removed'))}/>
              </div>
            </div>
            {!w.active && <p className="mt-2 text-xs text-danger">{t('webhooks.offHelp')}</p>}
            {open === w.id && <div className="mt-3"><Deliveries id={w.id}/></div>}
          </>}
        </li>)}</ul>}
      <details className="rounded-xl border border-border p-3 text-sm">
        <summary className="cursor-pointer font-medium">{t('webhooks.verifyTitle')}</summary>
        <p className="mt-2 text-muted">{t('webhooks.verifyHelp')}</p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-default p-3 text-xs">{`const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) && Date.now() / 1000 - Number(t) < 300;`}</pre>
      </details>
    </div>
  </Section>;
}

export default function Developer() {
  const t = useTranslations('Developer');
  return <div className="flex flex-col gap-6">
    <Tokens/>
    <Webhooks/>
    <Section title={t('usage.title')} description={t('usage.help')}>
      <pre className="overflow-x-auto rounded-lg bg-default p-3 text-xs">{`curl -H "Authorization: Bearer lvm_…" ${typeof window === 'undefined' ? '' : window.location.origin}/api/servers

curl -X POST -H "Authorization: Bearer lvm_…" -H "Idempotency-Key: $(uuidgen)" \\
  -H "content-type: application/json" -d '{"action":"reset"}' \\
  ${typeof window === 'undefined' ? '' : window.location.origin}/api/servers/<id>/actions`}</pre>
      <p className="mt-2 text-xs text-muted">{t('usage.docs')}</p>
    </Section>
  </div>;
}
