"use client";
// Ready-made and saved commands beside a console: one click types the command into it (and Enter, when chosen).
// Also the way to paste text, which the VMware console cannot take from the clipboard. Saved commands are the person's own.
import { fold } from '../lib/search';
import { Button, toast } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useMe } from '../lib/me';
import { can } from '../lib/permissions';
import { useApiAction, useApiQuery } from '../lib/query';
import { I } from './icon';
import { CheckboxInput, ConfirmButton, Section, TextInput } from './ui';
import { firstLine, uniqueName } from '../lib/proposals';
import { useProposal } from '../lib/use-proposal';

type Snippet = { id: string; name: string; command: string; shared: boolean; mine: boolean };
// Read-only: they show the state, never change it. Windows ones are PowerShell.
const linux = [
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
const windows: [typeof linux[number][0], string][] = [
  ['summary', 'Get-CimInstance Win32_OperatingSystem | Select-Object Caption, LastBootUpTime, FreePhysicalMemory'],
  ['disk', 'Get-PSDrive -PSProvider FileSystem'],
  ['memory', 'Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory'],
  ['network', 'ipconfig /all'],
  ['ports', 'Get-NetTCPConnection -State Listen | Sort-Object LocalPort'],
  ['topCpu', 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 10'],
  ['failed', "Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' }"],
  ['logs', 'Get-WinEvent -LogName System -MaxEvents 50'],
  ['os', 'Get-ComputerInfo -Property OsName, OsVersion, OsBuildNumber'],
];
const osKey = 'lvm.snippetOs';

// linuxOnly: the host terminal (a Linux shell that takes pasted text itself): no Windows commands, no paste note.
export function ConsoleSnippets({ send, ready, linuxOnly }: { send: (text: string) => void; ready: boolean; linuxOnly?: boolean }) {
  const t = useTranslations('Snippets');
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [enter, setEnter] = useState(false);
  const [share, setShare] = useState(false);
  const [editing, setEditing] = useState<Snippet>();
  const [chosen, setOs] = useState<'linux' | 'windows'>('linux');
  const os = linuxOnly ? 'linux' : chosen;
  const [filter, setFilter] = useState('');
  // The last chosen system is a per-browser convenience.
  useEffect(() => { try { if (localStorage.getItem(osKey) === 'windows') setOs('windows'); } catch { /* storage blocked */ } }, []);
  const pick = (v: typeof chosen) => { setOs(v); try { localStorage.setItem(osKey, v); } catch { /* storage blocked */ } };
  const mayShare = can(useMe()?.permissions, 'settings.manage');
  const all = useApiQuery<{ snippets: Snippet[] }>(['console-snippets'], '/console-snippets').data?.snippets ?? [];
  const f = fold(filter.trim());
  const saved = f ? all.filter((s) => fold(`${s.name}\n${s.command}`).includes(f)) : all;
  // A new command is named by its first line until a name is typed (an edited one keeps its name).
  const { proposed, again } = useProposal(editing ? undefined : uniqueName(firstLine(text, 60), all.map((s) => s.name), { max: 60 }), name, setName);
  const reset = (s?: Snippet) => { setEditing(s); setText(s?.command ?? ''); setName(s?.name ?? ''); setShare(!!s?.shared); again(); };
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
      {!linuxOnly && <div role="group" aria-label={t('os')} className="flex w-fit gap-1 rounded-full border border-border p-1">
        {([['linux', 'square-terminal'], ['windows', 'monitor']] as const).map(([v, icon]) => <Button key={v} size="sm" variant={os === v ? 'primary' : 'ghost'} aria-pressed={os === v} onPress={() => pick(v)}>
          <I name={icon} size={14}/>{t(`osName.${v}`)}</Button>)}
      </div>}
      <div role="group" aria-label={t('builtIn')} className="flex flex-wrap gap-2">
        {(os === 'linux' ? linux : windows).map(([key, command]) => <Button key={key} size="sm" variant="secondary" className={chip} isDisabled={!ready}
          aria-label={t('typeOne', { name: t(`b.${key}`), command })} onPress={() => type(command, t(`b.${key}`))}>
          <I name="square-terminal" size={14}/>{t(`b.${key}`)}</Button>)}
      </div>
      {all.length > 5 && <TextInput transient label={t('filter')} value={filter} onChange={setFilter} className="max-w-sm"/>}
      {f && !saved.length && <p className="text-sm text-muted">{t('noMatch')}</p>}
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
              <ConfirmButton size="sm" variant="ghost" label={<><I name="x" size={14}/><span className="sr-only">{t('remove', { name: s.name })}</span></>}
                title={t('remove', { name: s.name })} body={s.shared ? t('removeSharedBody') : t('removeBody')} confirmLabel={t('removeYes')} cancelLabel={t('cancelEdit')}
                onConfirm={() => remove.mutateAsync(s).then(() => { if (editing?.id === s.id) reset(); })}/>
            </>}
          </li>)}
        </ul>)}
      <div className="grid gap-3 md:grid-cols-[1fr_14rem]">
        <TextInput label={t('text')} value={text} onChange={setText} multiline spellCheck={false} maxLength={2000} help={linuxOnly ? t('textHelpShell') : t('textHelp')}/>
        <TextInput label={t('name')} value={name} onChange={setName} maxLength={60} help={t('nameHelp')} proposed={proposed}/>
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
