"use client";
// Applications installed after the first boot (cPanel, Plesk, own scripts): price, minimum shape, the script
// and, for key-based licences, the key pool the orders take from.
import { Button, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../../components/icon';
import { ConfirmButton, DataTable, FieldGroup, Mono, NumberInput, SelectInput, StatusChip, SwitchInput, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useApiForm } from '../../../../lib/form';
import { useApiAction, useApiQuery } from '../../../../lib/query';

type Kind = 'cpanel' | 'plesk' | 'custom';
type App = { id: string; name: string; kind: Kind; description: string; script: string; licenseMode: 'none' | 'pool'; minMemoryMb: number; minDiskGb: number;
  priceMonthly: string; active: boolean; licensesFree: number; licensesTotal: number; servers: number };
type Preset = { id: string; name: string; kind: Kind; minMemoryMb: number; minDiskGb: number; licenseMode: 'none' | 'pool'; script: string };
type License = { id: string; hint: string; assignedAt: string | null; serverId: string | null; serverName: string | null };
const key = ['catalog', 'applications'];

function Dialog({ open, setOpen, title, children }: { open: boolean; setOpen: (v: boolean) => void; title: string; children: React.ReactNode }) {
  return <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
    <Modal.Container size="lg" scroll="inside">
      <Modal.Dialog className="sm:max-w-3xl">
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading>{title}</Modal.Heading></Modal.Header>
        <Modal.Body>{children}</Modal.Body>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}

export function Applications({ currency }: { currency: string }) {
  const t = useTranslations('Catalog.apps');
  const format = useFormatter();
  const q = useApiQuery<{ applications: App[]; defaults: Record<Kind, string>; presets: Preset[] }>(key, '/admin/applications').data;
  const [editing, setEditing] = useState<App | 'new' | null>(null);
  const [keys, setKeys] = useState<App | null>(null);
  const remove = useApiAction((id: string) => apiFetch(`/admin/applications/${id}`, { method: 'DELETE' }), { invalidate: [key], success: t('removed') });
  if (!q) return <p role="status" className="text-sm text-muted">{t('loading')}</p>;
  return <>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-3xl text-sm text-muted">{t('explain')}</p>
      <Button onPress={() => setEditing('new')}><I name="plus" size={16}/>{t('new')}</Button>
    </div>
    <DataTable label={t('title')} rows={q.applications} rowKey={(a) => a.id} empty={t('empty')} minWidth={760}
      columns={[{ id: 'name', label: t('name') }, { id: 'kind', label: t('kind') }, { id: 'min', label: t('minimum') }, { id: 'price', label: t('price') },
        { id: 'lic', label: t('licenses') }, { id: 'servers', label: t('servers') }, { id: 'act', label: <span className="sr-only">{t('actions')}</span> }]}
      cells={(a) => [<span key="n" className="flex flex-col"><span className="font-medium">{a.name}</span>{!a.active && <span className="text-xs text-warning">{t('inactive')}</span>}</span>,
        t(`kinds.${a.kind}`), t('minShape', { memory: format.number(a.minMemoryMb / 1024, { maximumFractionDigits: 1 }), disk: a.minDiskGb }),
        Number(a.priceMonthly) ? format.number(Number(a.priceMonthly), { style: 'currency', currency }) : t('free'),
        a.licenseMode === 'pool' ? <StatusChip key="l" tone={a.licensesFree ? 'success' : 'danger'}>{t('licensesFree', { free: a.licensesFree, total: a.licensesTotal })}</StatusChip> : t('noLicense'),
        a.servers,
        <span key="a" className="flex gap-1">
          <Button size="sm" variant="ghost" onPress={() => setEditing(a)}><I name="pencil" size={14}/>{t('edit')}</Button>
          {a.licenseMode === 'pool' && <Button size="sm" variant="ghost" onPress={() => setKeys(a)}><I name="key-round" size={14}/>{t('keys')}</Button>}
          <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={15}/>} label={t('remove')} title={`${t('remove')}: ${a.name}`} body={t('removeConfirm', { name: a.name })}
            confirmLabel={t('remove')} cancelLabel={t('cancel')} isDisabled={a.servers > 0} onConfirm={() => remove.mutateAsync(a.id).then(() => undefined)}/>
        </span>]}/>
    <Dialog open={editing !== null} setOpen={(v) => !v && setEditing(null)} title={editing === 'new' ? t('new') : t('editTitle')}>
      {editing === 'new' ? <Presets presets={q.presets} defaults={q.defaults} onDone={() => setEditing(null)}/> : editing && <AppForm app={editing} defaults={q.defaults} onDone={() => setEditing(null)}/>}
    </Dialog>
    <Dialog open={keys !== null} setOpen={(v) => !v && setKeys(null)} title={keys ? t('keysTitle', { name: keys.name }) : ''}>
      {keys && <Licenses app={keys}/>}
    </Dialog>
  </>;
}

// A new application starts from a template (or an empty script); the form then shows it for editing.
function Presets({ presets, defaults, onDone }: { presets: Preset[]; defaults: Record<Kind, string>; onDone: () => void }) {
  const t = useTranslations('Catalog.apps');
  const [picked, setPicked] = useState<Preset | null>(null);
  if (picked) return <AppForm app={null} preset={picked} defaults={defaults} onDone={onDone}/>;
  const blank: Preset = { id: 'blank', name: '', kind: 'custom', minMemoryMb: 512, minDiskGb: 10, licenseMode: 'none', script: defaults.custom };
  return <div className="flex flex-col gap-3">
    <p className="text-sm text-muted">{t('presetsExplain')}</p>
    <ul className="grid gap-2 sm:grid-cols-2">
      {[...presets, blank].map((p) => <li key={p.id}>
        <button type="button" onClick={() => setPicked(p)} className="flex h-full w-full items-start gap-3 rounded-xl border border-border p-3 text-left transition hover:border-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent">
          <I name={{ blank: 'file-code', custom: 'package', cpanel: 'layout-panel-left', plesk: 'layout-panel-left' }[p.id === 'blank' ? 'blank' : p.kind]} size={20} className="mt-0.5 shrink-0 text-accent"/>
          <span className="flex flex-col">
            <span className="font-medium">{p.id === 'blank' ? t('blank') : p.name}</span>
            <span className="text-xs text-muted">{t.has(`presets.${p.id}` as 'presets.docker') ? t(`presets.${p.id}` as 'presets.docker') : ''}</span>
          </span>
        </button>
      </li>)}
    </ul>
  </div>;
}

function AppForm({ app, preset, defaults, onDone }: { app: App | null; preset?: Preset; defaults: Record<Kind, string>; onDone: () => void }) {
  const t = useTranslations('Catalog.apps');
  const client = useQueryClient();
  const f = useApiForm({ name: app?.name ?? preset?.name ?? '', kind: app?.kind ?? preset?.kind ?? 'custom', description: app?.description ?? '', script: app?.script ?? preset?.script ?? defaults.custom,
    licenseMode: app?.licenseMode ?? preset?.licenseMode ?? 'none', minMemoryMb: String(app?.minMemoryMb ?? preset?.minMemoryMb ?? 512), minDiskGb: String(app?.minDiskGb ?? preset?.minDiskGb ?? 10), priceMonthly: app?.priceMonthly ?? '0' });
  const [active, setActive] = useState(app?.active ?? true);
  // Switching the kind of a new application brings its starting script, unless the admin already changed it.
  const kind = (k: string) => f.setValues((v) => ({ ...v, kind: k as Kind, script: Object.values(defaults).includes(v.script) ? defaults[k as Kind] : v.script,
    licenseMode: k === 'cpanel' ? 'none' : v.licenseMode }));
  const num = (v: string) => (v === '' ? undefined : Number(v));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await f.submit(app ? 'PUT' : 'POST', app ? `/admin/applications/${app.id}` : '/admin/applications', { ...f.values, priceMonthly: f.values.priceMonthly.replace(',', '.'), active });
    if (ok) { await client.invalidateQueries({ queryKey: key }); toast.success(t('saved')); onDone(); }
  }
  return <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
    <FieldGroup title={t('identity')}>
      <TextInput label={t('name')} value={f.values.name} onChange={f.set('name')} error={f.fieldError('name')} isRequired placeholder="Plesk Web Pro"/>
      <SelectInput label={t('kind')} value={f.values.kind} onChange={kind} options={(['cpanel', 'plesk', 'custom'] as const).map((k) => ({ id: k, label: t(`kinds.${k}`) }))}/>
      <div className="sm:col-span-2"><TextInput label={t('description')} value={f.values.description} onChange={f.set('description')} maxLength={300} help={t('descriptionHelp')}/></div>
    </FieldGroup>
    <FieldGroup title={t('requirements')} description={t('requirementsHelp')} cols={3}>
      <NumberInput label={t('minMemory')} value={num(f.values.minMemoryMb) !== undefined ? num(f.values.minMemoryMb)! / 1024 : undefined} step={0.5} minValue={0.25}
        onChange={(v) => f.set('minMemoryMb')(v === undefined ? '' : String(Math.round(v * 1024)))} error={f.fieldError('minMemoryMb')}/>
      <NumberInput label={t('minDisk')} value={num(f.values.minDiskGb)} onChange={(v) => f.set('minDiskGb')(v === undefined ? '' : String(v))} minValue={1} error={f.fieldError('minDiskGb')}/>
      <TextInput label={t('price')} value={f.values.priceMonthly} onChange={f.set('priceMonthly')} error={f.fieldError('priceMonthly')} help={t('priceHelp')}/>
    </FieldGroup>
    <FieldGroup title={t('licensing')} description={t('licensingHelp')} cols={1}>
      <SelectInput label={t('licenseMode')} value={f.values.licenseMode} onChange={(v) => f.set('licenseMode')(v as 'none' | 'pool')}
        options={[{ id: 'none', label: t('modes.none') }, { id: 'pool', label: t('modes.pool') }]}/>
    </FieldGroup>
    <FieldGroup title={t('script')} description={t('scriptHelp', { license: '{LICENSE}', hostname: '{HOSTNAME}', ip: '{IP}' })} cols={1}>
      <TextInput label={t('script')} multiline value={f.values.script} onChange={f.set('script')} error={f.fieldError('script')} spellCheck={false}/>
      <Button size="sm" variant="ghost" onPress={() => f.set('script')(defaults[f.values.kind as Kind])}><I name="rotate-ccw" size={14}/>{t('resetScript')}</Button>
    </FieldGroup>
    <SwitchInput label={t('active')} isSelected={active} onChange={setActive}/>
    {f.failure && <p role="alert" className="text-sm text-danger">{f.failure.text}</p>}
    <div className="sticky bottom-0 -mx-1 flex justify-end gap-2 border-t border-separator bg-overlay px-1 py-3">
      <Button variant="tertiary" onPress={onDone}>{t('cancel')}</Button>
      <Button type="submit" isPending={f.busy}><I name="check" size={16}/>{t('save')}</Button>
    </div>
  </form>;
}

function Licenses({ app }: { app: App }) {
  const t = useTranslations('Catalog.apps');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const lkey = [...key, app.id, 'licenses'];
  const rows = useApiQuery<{ licenses: License[] }>(lkey, `/admin/applications/${app.id}/licenses`).data?.licenses ?? [];
  const [text, setText] = useState('');
  const [fieldErr, setFieldErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: key });
  async function add() {
    setBusy(true); setFieldErr(undefined);
    try {
      const r = await apiFetch<{ added: number }>(`/admin/applications/${app.id}/licenses`, { method: 'POST', body: { keys: text } });
      toast.success(t('keysAdded', { n: r.added })); setText(''); refresh();
    } catch (e) { const fe = (e as { fields?: Record<string, string> }).fields?.keys; setFieldErr(fe ? field(fe) : undefined); if (!fe) toast.danger(error(e)); } finally { setBusy(false); }
  }
  const remove = async (id: string) => { try { await apiFetch(`/admin/applications/licenses/${id}`, { method: 'DELETE' }); refresh(); } catch (e) { toast.danger(error(e)); } };
  return <div className="flex flex-col gap-4">
    <p className="text-sm text-muted">{t('keysExplain')}</p>
    <TextInput label={t('keysAdd')} multiline value={text} onChange={setText} error={fieldErr} help={t('keysAddHelp')} spellCheck={false}/>
    <div className="flex justify-end"><Button isPending={busy} isDisabled={!text.trim()} onPress={add}><I name="plus" size={16}/>{t('keysAddButton')}</Button></div>
    <DataTable label={t('keys')} rows={rows} rowKey={(l) => l.id} empty={t('keysEmpty')} minWidth={480}
      columns={[{ id: 'k', label: t('key') }, { id: 's', label: t('assignedTo') }, { id: 'a', label: <span className="sr-only">{t('remove')}</span> }]}
      cells={(l) => [<Mono key="k">…{l.hint}</Mono>, l.serverName ?? <span key="f" className="text-success">{t('keyFree')}</span>,
        l.serverId ? '' : <Button key="r" size="sm" variant="ghost" onPress={() => remove(l.id)}><I name="trash-2" size={14}/>{t('remove')}</Button>]}/>
  </div>;
}
