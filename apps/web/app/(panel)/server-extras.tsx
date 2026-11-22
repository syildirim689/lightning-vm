"use client";
// Helpers on a server's page: connect details to copy, the owner's tags and notes, and "order a similar one".
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { I } from '../../components/icon';
import { Mono, Section, TextInput } from '../../components/ui';
import { useApiForm } from '../../lib/form';
import { apiFetch, type ApiError, useErrorText } from '../../lib/api';
import { useOrder } from '../../lib/order-store';
import { useUnsaved } from '../../lib/unsaved';
import { useCopy } from '../../lib/clipboard';
import type { Server } from './servers-ui';
import { hostLabel, hostName, uniqueName } from '../../lib/proposals';

// Copies through lib/clipboard: the fallback for a panel opened over plain HTTP, and "copied" only when it really was.
export function Copy({ text, label, className = '' }: { text: string; label: string; className?: string }) {
  const t = useTranslations('Extras');
  const copy = useCopy();
  return <Button size="sm" variant="ghost" isIconOnly aria-label={`${t('copy')}: ${label}`} className={`min-h-9 min-w-9 ${className}`}
    onPress={() => void copy(text, t('copied', { what: label }))}><I name="copy" size={15}/></Button>;
}

export function QuickConnect({ server }: { server: Server }) {
  const t = useTranslations('Extras');
  if (!server.address) return null;
  const rows: [string, string][] = [[t('ip'), server.address], [t('ssh'), `ssh root@${server.address}`], [t('scp'), `scp ./file root@${server.address}:/root/`]];
  return <Section title={t('connect')} description={t('connectHelp')}>
    <ul className="flex flex-col divide-y divide-separator">
      {rows.map(([label, text]) => <li key={label} className="flex items-center gap-3 py-2">
        <span className="w-16 shrink-0 text-xs text-muted">{label}</span>
        <span className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap"><Mono>{text}</Mono></span>
        <Copy text={text} label={label}/>
      </li>)}
    </ul>
  </Section>;
}

export function ServerLabels({ server }: { server: Server }) {
  const t = useTranslations('Extras');
  const client = useQueryClient();
  const f = useApiForm({ tags: server.tags ?? [], notes: server.notes ?? '' });
  const [draft, setDraft] = useState('');
  const dirty = JSON.stringify(f.values) !== JSON.stringify({ tags: server.tags ?? [], notes: server.notes ?? '' });
  useUnsaved(dirty);
  const add = () => {
    const v = draft.trim().replace(/\s+/g, ' ');
    if (v && !f.values.tags.some((x) => x.toLocaleLowerCase('tr') === v.toLocaleLowerCase('tr'))) f.set('tags')([...f.values.tags, v]);
    setDraft('');
  };
  return <Section title={t('labels')} description={t('labelsHelp')}>
    <form className="flex flex-col gap-4" noValidate onSubmit={async (e) => {
      e.preventDefault();
      if (await f.submit('PUT', `/servers/${server.id}/labels`)) {
        toast.success(t('saved'));
        client.invalidateQueries({ queryKey: ['servers'] });
      }
    }}>
      <div className="flex flex-col gap-2">
        {f.values.tags.length > 0 && <ul className="flex flex-wrap gap-2" aria-label={t('tags')}>
          {f.values.tags.map((tag) => <li key={tag} className="flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-3 pr-1 text-sm text-accent-soft-foreground">
            <I name="tag" size={12}/>{tag}
            <button type="button" aria-label={t('removeTag', { tag })} className="grid size-7 place-items-center rounded-full hover:bg-default"
              onClick={() => f.set('tags')(f.values.tags.filter((x) => x !== tag))}><I name="x" size={12}/></button>
          </li>)}
        </ul>}
        <div className="flex items-end gap-2" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); add(); } }}>
          <TextInput format="tag" className="flex-1" label={t('addTag')} value={draft} onChange={setDraft} maxLength={24} placeholder={t('tagPlaceholder')} error={f.fieldError('tags')} help={t('tagHelp')}/>
          <Button type="button" variant="secondary" className="mb-6" onPress={add} isDisabled={!draft.trim() || f.values.tags.length >= 10}><I name="plus" size={15}/>{t('add')}</Button>
        </div>
      </div>
      <TextInput label={t('notes')} value={f.values.notes} onChange={f.set('notes')} multiline maxLength={2000} error={f.fieldError('notes')} help={t('notesHelp', { n: 2000 - f.values.notes.length })}/>
      <div><Button type="submit" isPending={f.busy} isDisabled={!dirty}><I name="save" size={15}/>{t('save')}</Button></div>
    </form>
  </Section>;
}

// Starts the order form with this server's location, image and size (package or custom), and a free name.
export function OrderSimilar({ server, names }: { server: Server; names: string[] }) {
  const t = useTranslations('Extras');
  const router = useRouter();
  const set = useOrder((s) => s.set);
  if (server.vdcId) return null;
  const name = hostName(server.name.replace(/-\d+$/, ''), names);
  return <Button variant="secondary" onPress={() => {
    set({ poolId: server.poolId, imageId: server.imageId, type: server.packageId ? 'package' : 'custom', packageId: server.packageId ?? '',
      vcpu: server.vcpu, memoryMb: server.memoryMb, diskGb: server.diskGb, name });
    router.push('/order');
  }}><I name="copy-plus" size={16}/>{t('orderSimilar')}</Button>;
}

// A new name in the panel (the default reverse DNS follows); the hostname inside the server stays the customer's.
export function RenameServer({ server }: { server: Server }) {
  const t = useTranslations('Extras');
  const [open, setOpen] = useState(false);
  if (!open) return <Button variant="ghost" onPress={() => setOpen(true)}><I name="pencil" size={16}/>{t('rename')}</Button>;
  return <RenameForm server={server} onClose={() => setOpen(false)}/>;
}

// The rename form itself: on the server's page beside its button, and in a dialog from the list's quick menu.
export function RenameForm({ server, onClose, autoFocus }: { server: Pick<Server, 'id' | 'name'>; onClose: () => void; autoFocus?: boolean }) {
  const t = useTranslations('Extras');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const [name, setName] = useState(server.name);
  const form = useRef<HTMLFormElement>(null);
  // In a dialog the field is what the person came for: it takes the focus once, not the close button.
  useEffect(() => { if (autoFocus) form.current?.querySelector('input')?.focus(); }, [autoFocus]);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr(undefined);
    try { await apiFetch(`/servers/${server.id}/name`, { method: 'PUT', body: { name } }); toast.success(t('renamed')); onClose(); client.invalidateQueries({ queryKey: ['servers'] }); }
    catch (e) { setErr(field((e as ApiError).fields?.name) ?? error(e)); } finally { setBusy(false); }
  }
  return <form className="flex w-full flex-wrap items-end gap-2 sm:w-auto" onSubmit={(e) => { e.preventDefault(); void save(); }}
    ref={form}>
    <TextInput format="serverName" className="min-w-48 flex-1" label={t('newName')} value={name} onChange={(x) => setName(x.toLowerCase())} maxLength={63} error={err} help={t('renameHelp')}/>
    <Button type="submit" isPending={busy} isDisabled={!name || name === server.name}><I name="check" size={15}/>{t('save')}</Button>
    <Button variant="ghost" onPress={onClose}>{t('cancel')}</Button>
  </form>;
}

// The same server again with its disk: the order page opens with this server's location, image and size, and the
// new VM is cloned from this one (cloud-init gives it its own name, address and keys).
export function CloneServer({ server, names }: { server: Server; names: string[] }) {
  const t = useTranslations('Extras');
  const router = useRouter();
  const set = useOrder((s) => s.set);
  if (server.vdcId || server.state !== 'ready') return null;
  // "web-1-copy", "web-1-copy2": always a valid host name, also for a 63-character original.
  const name = uniqueName(`${hostLabel(server.name, 58)}-copy`, names, { max: 63, sep: '' });
  return <Button variant="ghost" onPress={() => {
    set({ poolId: server.poolId, imageId: server.imageId, type: server.packageId ? 'package' : 'custom', packageId: server.packageId ?? '', applicationId: '',
      vcpu: server.vcpu, memoryMb: server.memoryMb, diskGb: server.diskGb, name, cloneFrom: server.id, cloneName: server.name });
    router.push('/order');
  }}><I name="copy" size={16}/>{t('clone')}</Button>;
}
