"use client";
// ISO library in the catalog: storages (FTP/FTPS, SFTP, WebDAV, S3, SMB, HTTP), browsing them, copying an ISO
// into one or more locations, and the library with live copy progress.
import { Button, Modal, ProgressBar, toast } from '@heroui/react';
import { useUnits } from '../../../../lib/units';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../../components/icon';
import { CheckboxInput, CheckboxList, ConfirmButton, DataTable, Empty, FieldGroup, Mono, NumberInput, SelectInput, StatusChip, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { useApiAction, useApiQuery } from '../../../../lib/query';

type Field = { key: string; type: 'text' | 'number' | 'bool' | 'textarea'; required?: boolean; secret?: boolean; default?: string | number | boolean };
type Source = { id: string; name: string; protocol: string; config: Record<string, string | number | boolean>; basePath: string; secretsSet: string[]; isos: number };
type Iso = { id: string; name: string; fileName: string; poolId: string; poolName: string; sourceName: string | null; sourcePath: string; sizeBytes: number | null; copiedBytes: number;
  state: 'copying' | 'ready' | 'failed' | 'deleting'; error: string | null; public: boolean; servers: number };
type Entry = { name: string; dir: boolean; size: number | null };
const keys = { sources: ['catalog', 'iso-sources'], isos: ['catalog', 'isos'] };

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

// One size format for the whole panel (lib/units).
export function useBytes() { return useUnits().bytes; }

export function IsoLibrary({ pools }: { pools: { id: string; name: string }[] }) {
  const t = useTranslations('Catalog.isos');
  const bytes = useBytes();
  const src = useApiQuery<{ protocols: Record<string, Field[]>; sources: Source[] }>(keys.sources, '/admin/iso-sources').data;
  // Every 2 s while a copy or a delete is running.
  const isos = useApiQuery<{ isos: Iso[] }>(keys.isos, '/admin/isos', { refetchInterval: (d) => (d?.isos.some((i) => i.state === 'copying' || i.state === 'deleting') ? 2000 : false) }).data?.isos ?? [];
  const [editing, setEditing] = useState<Source | 'new' | null>(null);
  const [browsing, setBrowsing] = useState<Source | null>(null);
  const removeSource = useApiAction((id: string) => apiFetch(`/admin/iso-sources/${id}`, { method: 'DELETE' }), { invalidate: [keys.sources], success: t('removed') });
  const removeIso = useApiAction((id: string) => apiFetch(`/admin/isos/${id}`, { method: 'DELETE' }), { invalidate: [keys.isos], success: t('isoRemoving') });
  const retry = useApiAction((id: string) => apiFetch(`/admin/isos/${id}/retry`, { method: 'POST' }), { invalidate: [keys.isos] });
  if (!src) return <p role="status" className="text-sm text-muted">{t('loading')}</p>;
  const tone = (s: Iso['state']) => (s === 'ready' ? 'success' : s === 'failed' ? 'danger' : s === 'deleting' ? 'warning' : 'accent');
  return <>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-3xl text-sm text-muted">{t('explain')}</p>
      <Button onPress={() => setEditing('new')}><I name="hard-drive-download" size={16}/>{t('newSource')}</Button>
    </div>

    <h3 className="mt-2 text-sm font-semibold">{t('sources')}</h3>
    {src.sources.length === 0 ? <Empty icon={<I name="server-cog" size={28}/>} title={t('noSources')}>{t('noSourcesHelp')}</Empty>
      : <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {src.sources.map((s) => <div key={s.id} className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-start gap-3">
            <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><I name={{ s3: 'cloud', http: 'globe' }[s.protocol] ?? 'folder-sync'} size={20}/></span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{s.name}</p>
              <p className="truncate text-xs text-muted">{t(`protocols.${s.protocol}` as 'protocols.ftp')} · <Mono>{String(s.config.host ?? s.config.url ?? s.config.endpoint ?? '')}</Mono></p>
            </div>
            <StatusChip tone="default">{t('isoCount', { n: s.isos })}</StatusChip>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="secondary" onPress={() => setBrowsing(s)}><I name="folder-open" size={14}/>{t('browse')}</Button>
            <Button size="sm" variant="ghost" onPress={() => setEditing(s)}><I name="pencil" size={14}/>{t('edit')}</Button>
            <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={t('remove')} title={`${t('remove')}: ${s.name}`} body={t('removeSourceConfirm')}
              confirmLabel={t('remove')} cancelLabel={t('cancel')} onConfirm={() => removeSource.mutateAsync(s.id).then(() => undefined)}/>
          </div>
        </div>)}
      </div>}

    <h3 className="mt-4 text-sm font-semibold">{t('library')}</h3>
    <DataTable label={t('library')} rows={isos} rowKey={(i) => i.id} empty={t('noIsos')} minWidth={820}
      columns={[{ id: 'name', label: t('name') }, { id: 'pool', label: t('location') }, { id: 'size', label: t('size') }, { id: 'state', label: t('state') },
        { id: 'servers', label: t('servers') }, { id: 'act', label: <span className="sr-only">{t('actions')}</span> }]}
      cells={(i) => [
        <span key="n" className="flex flex-col"><span className="font-medium">{i.name}</span><span className="text-xs text-muted">{i.sourceName ? `${i.sourceName}: ${i.sourcePath}` : i.sourcePath}{!i.public && ` · ${t('staffOnly')}`}</span></span>,
        i.poolName, bytes(i.sizeBytes),
        <span key="s" className="flex min-w-44 flex-col gap-1">
          <StatusChip tone={tone(i.state)}>{t(`states.${i.state}`)}</StatusChip>
          {i.state === 'copying' && <ProgressBar aria-label={t('progress', { name: i.name })} value={i.sizeBytes ? (i.copiedBytes / i.sizeBytes) * 100 : 0} size="sm">
            <ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>}
          {i.state === 'copying' && <span className="text-xs tabular-nums text-muted">{bytes(i.copiedBytes)} / {bytes(i.sizeBytes)}</span>}
          {i.state === 'failed' && i.error && <span className="text-xs text-danger">{i.error}</span>}
        </span>,
        i.servers,
        <span key="a" className="flex gap-1">
          {i.state === 'failed' && i.sourceName && <Button size="sm" variant="ghost" isPending={retry.isPending && retry.variables === i.id} onPress={() => retry.mutate(i.id)}><I name="rotate-ccw" size={14}/>{t('retry')}</Button>}
          {i.state !== 'deleting' && <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={t('remove')} title={`${t('remove')}: ${i.name}`}
            body={t('removeIsoConfirm')} confirmLabel={t('remove')} cancelLabel={t('cancel')} isDisabled={i.servers > 0} onConfirm={() => removeIso.mutateAsync(i.id).then(() => undefined)}/>}
        </span>]}/>

    <Dialog open={editing !== null} setOpen={(v) => !v && setEditing(null)} title={editing === 'new' ? t('newSource') : t('editSource')}>
      {editing && <SourceForm source={editing === 'new' ? null : editing} protocols={src.protocols} onDone={() => setEditing(null)}/>}
    </Dialog>
    <Dialog open={browsing !== null} setOpen={(v) => !v && setBrowsing(null)} title={browsing ? t('browseTitle', { name: browsing.name }) : ''}>
      {browsing && <Browser source={browsing} pools={pools} onDone={() => setBrowsing(null)}/>}
    </Dialog>
  </>;
}

function SourceForm({ source, protocols, onDone }: { source: Source | null; protocols: Record<string, Field[]>; onDone: () => void }) {
  const t = useTranslations('Catalog.isos');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const [name, setName] = useState(source?.name ?? '');
  const [protocol, setProtocol] = useState(source?.protocol ?? 'webdav');
  const [config, setConfig] = useState<Record<string, string | number | boolean>>(source?.config ?? {});
  const [basePath, setBasePath] = useState(source?.basePath ?? '');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'test'>();
  const [tested, setTested] = useState<string>();
  const body = () => ({ id: source?.id, name, protocol, config, basePath });
  const set = (k: string) => (v: string | number | boolean | undefined) => { setConfig((c) => ({ ...c, [k]: v ?? '' })); setFields((f) => ({ ...f, [k]: '' })); setTested(undefined); };
  async function call(kind: 'save' | 'test') {
    setBusy(kind); setFields({}); setTested(undefined);
    try {
      if (kind === 'test') {
        const r = await apiFetch<{ entries: number; isos: number }>('/admin/iso-sources/test', { method: 'POST', body: body() });
        setTested(t('testOk', { entries: r.entries, isos: r.isos }));
      } else {
        await apiFetch(source ? `/admin/iso-sources/${source.id}` : '/admin/iso-sources', { method: source ? 'PUT' : 'POST', body: body() });
        await client.invalidateQueries({ queryKey: keys.sources }); toast.success(t('saved')); onDone();
      }
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(undefined); }
  }
  const input = (f: Field) => {
    const label = t(`fields.${f.key}` as 'fields.host');
    const help = f.secret && source?.secretsSet.includes(f.key) ? t('secretKept') : t.has(`fieldHelp.${f.key}` as 'fieldHelp.tls') ? t(`fieldHelp.${f.key}` as 'fieldHelp.tls') : undefined;
    if (f.type === 'bool') return <CheckboxInput key={f.key} label={label} isSelected={Boolean(config[f.key] ?? f.default)} onChange={set(f.key)} help={help}/>;
    if (f.type === 'number') return <NumberInput key={f.key} label={label} value={Number(config[f.key] ?? f.default) || undefined} onChange={set(f.key)} minValue={1} maxValue={65535}
      error={field(fields[f.key])} formatOptions={{ useGrouping: false }}/>;
    return <TextInput key={f.key} label={label} type={f.secret && f.type === 'text' ? 'password' : 'text'} multiline={f.type === 'textarea'} isRequired={f.required && !(f.secret && source?.secretsSet.includes(f.key))}
      value={String(config[f.key] ?? '')} onChange={set(f.key)} error={field(fields[f.key])} help={help} spellCheck={false} autoComplete="off"
      placeholder={f.key === 'url' ? (protocol === 'webdav' ? 'https://dav.example.com/remote.php/dav/files/iso' : 'https://mirror.example.com/isos/') : f.key === 'endpoint' ? 'https://s3.example.com' : undefined}/>;
  };
  return <form className="flex flex-col gap-4" noValidate onSubmit={(e) => { e.preventDefault(); void call('save'); }}>
    <FieldGroup title={t('identity')}>
      <TextInput maxLength={60} label={t('name')} value={name} onChange={setName} error={field(fields.name)} isRequired placeholder="NAS ISO"/>
      <SelectInput label={t('protocol')} value={protocol} onChange={(v) => {
          // Fields the new protocol also has (host, user, password…) keep what was typed; the rest are dropped.
          const keep = new Set((protocols[v] ?? []).map((x) => x.key));
          setProtocol(v); setConfig((c) => Object.fromEntries(Object.entries(c).filter(([k]) => keep.has(k)))); setTested(undefined);
        }}
        options={Object.keys(protocols).map((p) => ({ id: p, label: t(`protocols.${p}` as 'protocols.ftp'), description: t(`protocolHelp.${p}` as 'protocolHelp.ftp') }))}/>
    </FieldGroup>
    <FieldGroup title={t('connection')} description={t(`protocolHelp.${protocol}` as 'protocolHelp.ftp')}>
      {protocols[protocol].map(input)}
      <TextInput label={t('basePath')} value={basePath} onChange={(v) => { setBasePath(v); setTested(undefined); }} error={field(fields.basePath)}
        help={t(protocol === 's3' ? 'basePathS3' : protocol === 'smb' ? 'basePathSmb' : 'basePathHelp')} spellCheck={false}/>
    </FieldGroup>
    {tested && <p role="status" className="flex items-center gap-2 text-sm text-success"><I name="circle-check" size={16}/>{tested}</p>}
    <div className="sticky bottom-0 -mx-1 flex flex-wrap justify-end gap-2 border-t border-separator bg-overlay px-1 py-3">
      <Button variant="tertiary" onPress={onDone}>{t('cancel')}</Button>
      <Button variant="secondary" isPending={busy === 'test'} isDisabled={!!busy} onPress={() => call('test')}><I name="plug-zap" size={16}/>{t('test')}</Button>
      <Button type="submit" isPending={busy === 'save'} isDisabled={!!busy}><I name="check" size={16}/>{t('save')}</Button>
    </div>
  </form>;
}

// Folder by folder; picking an ISO asks where to copy it.
function Browser({ source, pools, onDone }: { source: Source; pools: { id: string; name: string }[]; onDone: () => void }) {
  const t = useTranslations('Catalog.isos');
  const { error } = useErrorText();
  const bytes = useBytes();
  const client = useQueryClient();
  const [path, setPath] = useState('');
  const [data, setData] = useState<{ path: string; entries: Entry[] } | { path: string; error: string } | null>(null);
  const [picked, setPicked] = useState<Entry | null>(null);
  const [name, setName] = useState('');
  const [targets, setTargets] = useState<string[]>(pools.length === 1 ? [pools[0].id] : []);
  const [isPublic, setPublic] = useState(true);
  const [busy, setBusy] = useState(false);
  async function open(p: string) {
    setPath(p); setPicked(null); setData(null);
    try { setData({ path: p, ...(await apiFetch<{ entries: Entry[] }>(`/admin/iso-sources/${source.id}/browse`, { method: 'POST', body: { path: p } })) }); }
    catch (e) { setData({ path: p, error: error(e) }); }
  }
  useEffect(() => { void open(''); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const parts = path ? path.split('/') : [];
  async function copy() {
    if (!picked) return;
    setBusy(true);
    try {
      await apiFetch('/admin/isos', { method: 'POST', body: { sourceId: source.id, path: [path, picked.name].filter(Boolean).join('/'), name: name || picked.name, poolIds: targets, public: isPublic } });
      await client.invalidateQueries({ queryKey: keys.isos }); toast.success(t('copyStarted')); onDone();
    } catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <div className="flex flex-col gap-4">
    <nav aria-label={t('path')} className="flex flex-wrap items-center gap-1 text-sm">
      <Button size="sm" variant="ghost" onPress={() => open('')}><I name="house" size={14}/>{source.basePath || '/'}</Button>
      {parts.map((p, i) => <span key={i} className="flex items-center gap-1"><I name="chevron-right" size={14} className="text-muted"/>
        <Button size="sm" variant="ghost" onPress={() => open(parts.slice(0, i + 1).join('/'))}>{p}</Button></span>)}
    </nav>
    {data === null ? <p role="status" className="text-sm text-muted">{t('listing')}</p>
      : 'error' in data ? <p role="alert" className="text-sm text-danger">{data.error}</p>
      : data.entries.length === 0 ? <Empty icon={<I name="folder" size={28}/>} title={t('emptyFolder')}/>
      : <ul className="flex max-h-80 flex-col overflow-auto rounded-xl border border-border">
        {data.entries.map((e) => <li key={e.name} className="border-b border-separator last:border-0">
          <button type="button" onClick={() => (e.dir ? open([path, e.name].filter(Boolean).join('/')) : (setPicked(e), setName(e.name.replace(/\.iso$/i, ''))))}
            className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-default focus-visible:outline-2 focus-visible:outline-accent ${picked?.name === e.name ? 'bg-accent-soft' : ''}`}>
            <I name={e.dir ? 'folder' : 'disc-3'} size={18} className={e.dir ? 'text-warning' : 'text-accent'}/>
            <span className="flex-1 truncate">{e.name}</span>
            {!e.dir && <span className="text-xs tabular-nums text-muted">{bytes(e.size)}</span>}
          </button>
        </li>)}
      </ul>}
    {picked && <div className="flex flex-col gap-3 rounded-xl border border-accent/40 bg-accent-soft p-4">
      <p className="text-sm font-semibold">{t('copyTitle', { file: picked.name, size: bytes(picked.size) })}</p>
      <TextInput maxLength={100} label={t('displayName')} value={name} onChange={setName} help={t('displayNameHelp')}/>
      <CheckboxList label={t('locations')} value={targets} onChange={setTargets} options={pools.map((p) => ({ id: p.id, label: p.name }))} help={t('locationsHelp')}/>
      <CheckboxInput label={t('public')} isSelected={isPublic} onChange={setPublic} help={t('publicHelp')}/>
      <div className="flex justify-end"><Button isPending={busy} isDisabled={!targets.length} onPress={copy}><I name="copy" size={16}/>{t('copy')}</Button></div>
    </div>}
  </div>;
}
