"use client";
// Ready-made and saved commands beside a console: one click types the command into it (and Enter, when chosen).
// Also the way to paste text, which the VMware console cannot take from the clipboard. Saved commands are the person's own.
import { Button, toast } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { apiFetch } from '../lib/api';
import { useMe } from '../lib/me';
import { can } from '../lib/permissions';
import { useApiAction, useApiQuery } from '../lib/query';
import { I } from './icon';
import { CheckboxInput, Section, TextInput } from './ui';

type Snippet = { id: string; name: string; command: string; shared: boolean; mine: boolean };
// Linux, read-only: they show the state, never change it.
const builtIn = [
  ['summary', 'uptime && free -h && df -h /'],
  ['disk', 'df -h'],
  ['memory', 'free -h'],
  ['network', 'ip -br address'],
  ['ports', 'ss -tulpn'],
  ['topCpu', 'ps aux --sort=-%cpu | head -n 11'],
  ['failed', 'systemctl --failed'],
  ['logs', 'journalctl -n 50 --no-pager'],
  ['os', 'cat /etc/os-release'],
] as const;

export function ConsoleSnippets({ send, ready }: { send: (text: string) => void; ready: boolean }) {
  const t = useTranslations('Snippets');
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [enter, setEnter] = useState(false);
  const [share, setShare] = useState(false);
  const [editing, setEditing] = useState<Snippet>();
  const mayShare = can(useMe()?.permissions, 'settings.manage');
  const saved = useApiQuery<{ snippets: Snippet[] }>(['console-snippets'], '/console-snippets').data?.snippets ?? [];
  const reset = (s?: Snippet) => { setEditing(s); setText(s?.command ?? ''); setName(s?.name ?? ''); setShare(!!s?.shared); };
  const save = useApiAction(() => apiFetch(editing ? `/console-snippets/${editing.id}` : '/console-snippets',
    { method: editing ? 'PUT' : 'POST', body: { name, command: text, shared: mayShare && share } }),
    { invalidate: [['console-snippets']], success: editing ? t('updated') : t('saved'), onSuccess: () => reset() });
  const remove = useApiAction((s: Snippet) => apiFetch(`/console-snippets/${s.id}`, { method: 'DELETE' }), { invalidate: [['console-snippets']] });
  const type = (command: string, label: string) => {
    send(command.replace(/\r\n?/g, '\n') + (enter ? '\n' : ''));
    toast.success(enter ? t('ran', { name: label }) : t('typed', { name: label }));
  };
  const chip = 'max-w-full justify-start [overflow-wrap:anywhere] h-auto min-h-9 py-1.5 text-left';

  return <Section title={t('title')} description={ready ? t('help') : t('notReady')}>
    <div className="flex flex-col gap-4">
      <CheckboxInput label={t('enter')} isSelected={enter} onChange={setEnter} help={t('enterHelp')}/>
      <div role="group" aria-label={t('builtIn')} className="flex flex-wrap gap-2">
        {builtIn.map(([key, command]) => <Button key={key} size="sm" variant="secondary" className={chip} isDisabled={!ready}
          aria-label={t('typeOne', { name: t(`b.${key}`), command })} onPress={() => type(command, t(`b.${key}`))}>
          <I name="square-terminal" size={14}/>{t(`b.${key}`)}</Button>)}
      </div>
      {/* Shared (from the administrators) first, then the person's own. */}
      {([['shared', saved.filter((s) => s.shared)], ['mine', saved.filter((s) => !s.shared)]] as const).map(([group, list]) => list.length > 0 &&
        <ul key={group} aria-label={t(group)} className="flex flex-wrap gap-2">
          {list.map((s) => <li key={s.id} className={`flex max-w-full items-center rounded-full border ${s.shared ? 'border-accent/40 bg-accent/5' : 'border-border'}`}>
            <Button size="sm" variant="ghost" className={chip} isDisabled={!ready} aria-label={t('typeOne', { name: s.name, command: s.command })}
              onPress={() => type(s.command, s.name)}><I name={s.shared ? 'users' : 'bookmark'} size={14}/>{s.name}</Button>
            <Button size="sm" variant="ghost" isIconOnly className="min-h-9 min-w-9 shrink-0" aria-label={t('copy', { name: s.name })}
              onPress={async () => { await navigator.clipboard?.writeText(s.command).catch(() => undefined); toast.success(t('copied', { name: s.name })); }}><I name="copy" size={14}/></Button>
            {(s.mine || (s.shared && mayShare)) && <>
              <Button size="sm" variant="ghost" isIconOnly className="min-h-9 min-w-9 shrink-0" aria-label={t('edit', { name: s.name })}
                onPress={() => reset(s)}><I name="pencil" size={14}/></Button>
              <Button size="sm" variant="ghost" isIconOnly className="min-h-9 min-w-9 shrink-0" aria-label={t('remove', { name: s.name })}
                onPress={() => { remove.mutate(s); if (editing?.id === s.id) reset(); }}><I name="x" size={14}/></Button>
            </>}
          </li>)}
        </ul>)}
      <div className="grid gap-3 md:grid-cols-[1fr_14rem]">
        <TextInput label={t('text')} value={text} onChange={setText} multiline spellCheck={false} maxLength={2000} help={t('textHelp')}/>
        <TextInput label={t('name')} value={name} onChange={setName} maxLength={60} help={t('nameHelp')}/>
      </div>
      {mayShare && <CheckboxInput label={t('share')} isSelected={share} onChange={setShare} help={t('shareHelp')}/>}
      {editing && <p role="status" className="text-sm font-medium text-accent">{t('editing', { name: editing.name })}</p>}
      <div className="flex flex-wrap gap-2">
        <Button isDisabled={!ready || !text.trim()} onPress={() => type(text, t('yourText'))}><I name="keyboard" size={16}/>{t('send')}</Button>
        <Button variant="secondary" isDisabled={!text.trim()} isPending={save.isPending} onPress={() => save.mutate()}><I name="bookmark" size={16}/>{editing ? t('update') : t('save')}</Button>
        {editing && <Button variant="ghost" onPress={() => reset()}>{t('cancelEdit')}</Button>}
      </div>
    </div>
  </Section>;
}
