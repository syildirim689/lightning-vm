"use client";
// Settings → Status page: open an incident with its first update, add updates until it is resolved. Each one shows
// on the public status page and, while open, in a bar on every panel page.
import { Button, Card, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../../components/icon';
import { ConfirmButton, FormSection, Notice, SelectInput, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Incident = { id: string; title: string; impact: 'minor' | 'major' | 'maintenance'; status: string; components: string[]; createdAt: string; resolvedAt: string | null;
  updates: { status: string; body: string; at: string }[] };
const statuses = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
const parts = ['panel', 'database', 'queue', 'automation', 'virtualization'] as const;

export default function Incidents({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.incidents');
  const ts = useTranslations('PublicStatus');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const q = useApiQuery<{ incidents: Incident[] }>(['admin', 'incidents'], '/admin/incidents');
  const [form, setForm] = useState({ title: '', impact: 'minor', status: 'investigating', components: [] as string[], body: '' });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const refresh = () => { void client.invalidateQueries({ queryKey: ['admin', 'incidents'] }); void client.invalidateQueries({ queryKey: ['announcement'] }); };

  async function open() {
    setBusy(true); setFields({});
    try { await apiFetch('/admin/incidents', { method: 'POST', body: form }); toast.success(t('opened')); setForm({ title: '', impact: 'minor', status: 'investigating', components: [], body: '' }); refresh(); }
    catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }

  return <div className="flex flex-col gap-5">
    {!readOnly && <Card><Card.Content className="flex flex-col">
      <FormSection title={t('new')} description={t('newHelp')} icon={<I name="siren" size={16}/>}>
        <TextInput label={t('title')} value={form.title} onChange={(x) => setForm({ ...form, title: x })} maxLength={160} error={field(fields.title)} placeholder={t('titleExample')}/>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectInput label={t('impact')} value={form.impact} onChange={(x) => setForm({ ...form, impact: x })} options={(['minor', 'major', 'maintenance'] as const).map((x) => ({ id: x, label: ts(`impact.${x}`) }))}/>
          <SelectInput label={t('status')} value={form.status} onChange={(x) => setForm({ ...form, status: x })} options={statuses.map((x) => ({ id: x, label: ts(`incident.${x}`) }))}/>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('components')}</p>
          <div className="flex flex-wrap gap-2">{parts.map((c) => <button key={c} type="button" role="checkbox" aria-checked={form.components.includes(c)}
            onClick={() => setForm({ ...form, components: form.components.includes(c) ? form.components.filter((x) => x !== c) : [...form.components, c] })}
            className={`rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent ${form.components.includes(c) ? 'border-accent bg-accent/10 text-accent' : 'border-border hover:border-accent/50'}`}>
            {ts(`service.${c}.name` as 'service.panel.name')}</button>)}</div>
        </div>
        <TextInput multiline label={t('message')} value={form.body} onChange={(x) => setForm({ ...form, body: x })} error={field(fields.body)} help={t('messageHelp')}/>
        <div><Button isPending={busy} isDisabled={!form.title.trim() || !form.body.trim()} onPress={open}><I name="siren" size={16}/>{t('open')}</Button></div>
      </FormSection>
    </Card.Content></Card>}

    {q.data && q.data.incidents.length === 0 && <Notice tone="default">{t('none')}</Notice>}
    {q.data?.incidents.map((i) => <IncidentCard key={i.id} i={i} readOnly={readOnly} onChange={refresh}
      when={(at: string) => format.relativeTime(new Date(Math.min(Date.parse(at), now.getTime())), now)}/>)}
  </div>;
}

function IncidentCard({ i, readOnly, onChange, when }: { i: Incident; readOnly: boolean; onChange: () => void; when: (at: string) => string }) {
  const t = useTranslations('Settings.incidents');
  const ts = useTranslations('PublicStatus');
  const { error } = useErrorText();
  const [status, setStatus] = useState(i.status === 'resolved' ? 'resolved' : i.status);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  async function add() {
    setBusy(true);
    try { await apiFetch(`/admin/incidents/${i.id}/updates`, { method: 'POST', body: { status, body } }); setBody(''); toast.success(t('updated')); onChange(); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  const open = !i.resolvedAt;
  return <Card className={open ? (i.impact === 'major' ? 'border border-danger/40' : 'border border-warning/40') : ''}><Card.Content className="flex flex-col gap-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h3 className="font-semibold">{i.title}</h3><p className="text-xs text-muted">{ts(`impact.${i.impact}`)} · {when(i.createdAt)}</p></div>
      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${open ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success'}`}>{ts(`incident.${i.status as 'resolved'}`)}</span>
    </div>
    <ol className="flex flex-col gap-2 border-l-2 border-border pl-4">{i.updates.map((u, n) => <li key={n} className="text-sm">
      <span className="font-medium">{ts(`incident.${u.status as 'resolved'}`)}</span> <span className="text-xs text-muted">· {when(u.at)}</span>
      <p className="whitespace-pre-line text-muted">{u.body}</p></li>)}</ol>
    {!readOnly && <div className="flex flex-col gap-3 border-t border-separator pt-3">
      <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <SelectInput label={t('status')} value={status} onChange={setStatus} options={statuses.map((x) => ({ id: x, label: ts(`incident.${x}`) }))}/>
        <TextInput multiline label={t('update')} value={body} onChange={setBody}/>
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <Button size="sm" isPending={busy} isDisabled={!body.trim()} onPress={add}><I name="send" size={14}/>{t('addUpdate')}</Button>
        <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={t('remove')} title={t('removeTitle')} body={t('removeBody')} confirmLabel={t('remove')} cancelLabel={t('cancel')}
          onConfirm={async () => { await apiFetch(`/admin/incidents/${i.id}`, { method: 'DELETE' }).catch((e) => toast.danger(error(e))); onChange(); }}/>
      </div>
    </div>}
  </Card.Content></Card>;
}
