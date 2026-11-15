"use client";
// Operating system updates inside a server. The panel cannot look into a server, so a small reporter runs there
// (installed with one command shown here). This section shows what it reports, lets the owner choose what happens by
// itself (only tell me, install security updates, install everything, restart at a quiet hour) and start it now.
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../components/icon';
import { ConfirmButton, Notice, Section, SelectInput, StatusChip, SwitchInput } from '../../components/ui';
import { apiFetch, useErrorText } from '../../lib/api';
import { useApiQuery } from '../../lib/query';
import { Copy } from './server-extras';

type Pkg = { name: string; to: string; security: boolean };
type Run = { action: 'security' | 'upgrade' | 'reboot'; state: 'running' | 'succeeded' | 'failed'; auto: boolean; message: string; at: string };
type Data = { enabled: boolean; reported?: boolean; reportedAt?: string | null; stale?: boolean; policy?: 'notify' | 'security' | 'all'; autoReboot?: boolean; rebootHour?: number;
  pendingAction?: Run['action'] | null; os?: string | null; manager?: string | null; total?: number; security?: number; rebootRequired?: boolean; packages?: Pkg[]; lastRun?: Run | null; command?: string };

export function ServerUpdates({ serverId, windows, canChange, powered }: { serverId: string; windows: boolean; canChange: boolean; powered: boolean }) {
  const t = useTranslations('GuestUpdates');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { error } = useErrorText();
  const client = useQueryClient();
  const key = ['servers', serverId, 'updates'];
  const [command, setCommand] = useState<string>();
  const [busy, setBusy] = useState(false);
  const q = useApiQuery<Data>(key, `/servers/${serverId}/updates`, { refetchInterval: (d) => (!d?.enabled ? false : !d.reported || d.pendingAction || d.lastRun?.state === 'running' ? 10_000 : 60_000) });
  const d = q.data;
  if (!d) return null;

  async function send(path: string, method: string, body: object | undefined, done?: string) {
    setBusy(true);
    try {
      const r = await apiFetch<Data | undefined>(`/servers/${serverId}/updates${path}`, { method, body });
      if (r?.command) setCommand(r.command);
      if (done) toast.success(done);
      await client.invalidateQueries({ queryKey: key });
    } catch (e) { toast.danger(error(e)); throw e; } finally { setBusy(false); }
  }
  const quiet = (p: Promise<unknown>) => void p.catch(() => undefined);
  const install = command && <div className="flex flex-col gap-2">
    <p className="text-sm">{t('runThis')}</p>
    <div className="flex items-start gap-2 rounded-lg bg-default px-3 py-2"><pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">{command}</pre><Copy text={command} label={t('command')}/></div>
    <p className="text-xs text-muted">{t('commandOnce')}</p>
  </div>;

  if (windows && !d.enabled) return <Section title={t('title')}><p className="text-sm text-muted">{t('windows')}</p></Section>;
  if (!d.enabled) return <Section title={t('title')} description={t('intro')}>
    <div className="flex flex-col gap-3">
      <ul className="grid gap-2 text-sm sm:grid-cols-3">
        {(['see', 'auto', 'tell'] as const).map((k) => <li key={k} className="flex items-start gap-2 rounded-xl border border-border px-3 py-2">
          <I name={{ see: 'list-checks', auto: 'shield-check', tell: 'bell' }[k]} size={16} className="mt-0.5 shrink-0 text-accent"/><span>{t(`offer.${k}`)}</span></li>)}
      </ul>
      {canChange && <div><Button isPending={busy} onPress={() => quiet(send('/enable', 'POST', undefined))}><I name="download" size={15}/>{t('turnOn')}</Button></div>}
      <p className="text-xs text-muted">{t('supported')}</p>
    </div>
  </Section>;

  const waitingFirst = !d.reported;
  const ago = (iso?: string | null) => (iso ? format.relativeTime(new Date(Math.min(Date.parse(iso), now.getTime())), now) : '–');
  const blocked = !canChange || busy || waitingFirst || !!d.stale || !!d.pendingAction || d.lastRun?.state === 'running';
  const run = d.lastRun;
  const runFailed = run?.state === 'failed';
  const active = d.pendingAction ?? (run?.state === 'running' ? run.action : null);
  const hours = Array.from({ length: 24 }, (_, h) => ({ id: String(h), label: `${String(h).padStart(2, '0')}:00` }));

  return <Section title={t('title')} description={t('intro')} actions={d.os && <StatusChip tone="default">{d.os}</StatusChip>}>
    <div className="flex flex-col gap-5">
      {install}
      {waitingFirst && !command && <Notice tone="default" title={t('waitingTitle')}>{t('waiting')}
        {canChange && <> <button type="button" className="font-medium text-accent hover:underline" onClick={() => quiet(send('/enable', 'POST', undefined))}>{t('newCommand')}</button></>}</Notice>}
      {waitingFirst && command && <p role="status" className="flex items-center gap-2 text-sm text-muted"><I name="loader" size={14} className="animate-spin"/>{t('waitingReport')}</p>}
      {d.stale && <Notice tone="warning" title={t('staleTitle')}>{powered ? t('stale', { when: ago(d.reportedAt) }) : t('staleOff', { when: ago(d.reportedAt) })}
        {canChange && powered && <> <button type="button" className="font-medium text-accent hover:underline" onClick={() => quiet(send('/enable', 'POST', undefined))}>{t('newCommand')}</button></>}</Notice>}
      {d.manager === 'none' && d.reported && <Notice tone="default">{t('noManager')}</Notice>}

      {d.reported && d.manager !== 'none' && <>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile label={t('waitingCount')} value={format.number(d.total ?? 0)} tone={d.total ? 'accent' : 'success'} hint={d.total ? t('ready') : t('upToDate')}/>
          <Tile label={t('securityCount')} value={format.number(d.security ?? 0)} tone={d.security ? 'danger' : 'success'} hint={d.security ? t('securityFirst') : t('noSecurity')}/>
          <Tile label={t('restart')} value={d.rebootRequired ? t('restartNeeded') : t('restartNotNeeded')} tone={d.rebootRequired ? 'warning' : 'success'} hint={t('reported', { when: ago(d.reportedAt) })}/>
        </dl>
        {active && <p role="status" className="flex items-center gap-2 text-sm"><I name="loader" size={14} className="animate-spin text-accent"/>{d.pendingAction ? t('queuedHint', { action: t(`action.${active}`) }) : t('runningHint', { action: t(`action.${active}`) })}</p>}
        {!active && run && <p className={`flex items-start gap-2 text-sm ${run.state === 'failed' ? 'text-danger' : 'text-muted'}`}><I name={runFailed ? 'circle-x' : 'circle-check'} size={15} className="mt-0.5 shrink-0"/>
          <span>{t(run.state === 'failed' ? 'runFailed' : 'runDone', { action: t(`action.${run.action}`), when: ago(run.at) })}{run.auto && ` · ${t('byPolicy')}`}{run.state === 'failed' && run.message && <span className="block font-mono text-xs">{run.message}</span>}</span></p>}

        {canChange && <div className="flex flex-wrap items-center gap-2">
          <ConfirmButton variant="primary" icon={<I name="shield-check" size={16}/>} label={t('installSecurity', { n: d.security ?? 0 })} isDisabled={blocked || !d.security}
            title={t('installSecurityTitle')} body={t('installBody')} confirmLabel={t('install')} cancelLabel={t('cancel')} onConfirm={() => send('/actions', 'POST', { action: 'security' }, t('asked'))}/>
          <ConfirmButton variant="secondary" icon={<I name="download" size={16}/>} label={t('installAll', { n: d.total ?? 0 })} isDisabled={blocked || !d.total}
            title={t('installAllTitle')} body={t('installBody')} confirmLabel={t('install')} cancelLabel={t('cancel')} onConfirm={() => send('/actions', 'POST', { action: 'upgrade' }, t('asked'))}/>
          <ConfirmButton variant="danger-soft" icon={<I name="rotate-ccw" size={16}/>} label={t('restartNow')} isDisabled={blocked}
            title={t('restartTitle')} body={t('restartBody')} confirmLabel={t('restartNow')} cancelLabel={t('cancel')} onConfirm={() => send('/actions', 'POST', { action: 'reboot' }, t('asked'))}/>
        </div>}

        <div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
          <p className="text-sm font-medium">{t('policyTitle')}</p>
          <div role="radiogroup" aria-label={t('policyTitle')} className="grid gap-2 sm:grid-cols-3">
            {(['notify', 'security', 'all'] as const).map((p) => <button key={p} type="button" role="radio" aria-checked={d.policy === p} disabled={!canChange || busy} onClick={() => d.policy !== p && quiet(send('', 'PUT', { policy: p }, t('saved')))}
              className={`flex min-h-11 flex-col items-start rounded-xl border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 ${d.policy === p ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/50'}`}>
              <span className="font-medium">{t(`policy.${p}`)}</span><span className="text-xs text-muted">{t(`policyHelp.${p}`)}</span></button>)}
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <SwitchInput label={<span className="flex flex-col"><span>{t('autoReboot')}</span><span className="text-xs font-normal text-muted">{t('autoRebootHelp')}</span></span>}
              isSelected={!!d.autoReboot} isDisabled={!canChange || busy} onChange={(on) => quiet(send('', 'PUT', { autoReboot: on }, t('saved')))}/>
            {d.autoReboot && <SelectInput className="w-36" label={t('rebootHour')} value={String(d.rebootHour ?? 4)} isDisabled={!canChange || busy} options={hours}
              onChange={(h) => quiet(send('', 'PUT', { rebootHour: Number(h) }, t('saved')))}/>}
          </div>
        </div>

        {!!d.packages?.length && <details className="rounded-2xl border border-border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{t('packages', { n: d.total ?? 0 })}</summary>
          <ul className="flex max-h-72 flex-col divide-y divide-separator overflow-auto border-t border-separator px-4 py-2 text-sm">
            {d.packages.map((p) => <li key={p.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5"><span className="min-w-0 flex-1 break-all font-mono text-xs">{p.name}</span>
              <span className="font-mono text-xs text-muted">{p.to}</span>{p.security && <StatusChip tone="danger">{t('securityChip')}</StatusChip>}</li>)}
            {(d.total ?? 0) > d.packages.length && <li className="py-1.5 text-xs text-muted">{t('more', { n: (d.total ?? 0) - d.packages.length })}</li>}
          </ul>
        </details>}
      </>}

      {canChange && <div><ConfirmButton size="sm" variant="ghost" icon={<I name="power" size={14}/>} label={t('turnOff')} title={t('turnOffTitle')} body={t('turnOffBody')}
        confirmLabel={t('turnOff')} cancelLabel={t('cancel')} onConfirm={() => send('', 'DELETE', undefined, t('turnedOff')).then(() => setCommand(undefined))}/></div>}
    </div>
  </Section>;
}

function Tile({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint: string; tone: 'accent' | 'success' | 'warning' | 'danger' }) {
  const color = { accent: 'text-accent', success: 'text-success', warning: 'text-warning', danger: 'text-danger' }[tone];
  return <div className="rounded-xl border border-border px-3 py-2.5"><dt className="text-xs text-muted">{label}</dt>
    <dd className={`mt-0.5 text-lg font-semibold tabular-nums ${color}`}>{value}</dd><dd className="text-xs text-muted">{hint}</dd></div>;
}
