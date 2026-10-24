"use client";
// Updates from the panel: the API only drops a request; the host agent (scripts/install.sh agent) runs the
// same update the command line does (backup, drain, new version, health check, rollback on failure) and
// writes progress back. The panel keeps polling while it restarts and notices the new version.
import { Button, Spinner, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { I } from '../../../components/icon';
import { ConfirmButton, Mono, Notice, Section, SelectInput, StatusChip, SwitchInput, TextInput, type Tone } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { useMe } from '../../../lib/me';
import { can } from '../../../lib/permissions';
import { useApiQuery } from '../../../lib/query';

type Release = { version: string; date: string; notes: string };
type Status = { id: string; action: 'check' | 'update' | 'backup' | 'auto-update' | 'domain'; state: 'running' | 'succeeded' | 'failed' | 'rejected'; startedAt: string; finishedAt: string; exitCode: number | null; code: string };
type Data = {
  version: string; settings: Record<string, string>;
  releases: { checkedAt: string; channel: string; branch?: string; current: string; commit?: string; latest: string; updateAvailable: boolean; error: string; releases: Release[] } | null;
  agent: { installed: boolean; pending: number; status: Status | null; log: string[] };
};
const stateTone: Record<Status['state'], Tone> = { running: 'accent', succeeded: 'success', failed: 'danger', rejected: 'danger' };

export default function Updates() {
  const t = useTranslations('Updates');
  const format = useFormatter();
  const now = useNow({ updateInterval: 1000 });
  const { error } = useErrorText();
  const me = useMe();
  const client = useQueryClient();
  const manage = can(me?.permissions, 'system.update');
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState(false);
  const active = (d?: Data) => !!d && (d.agent.pending > 0 || d.agent.status?.state === 'running');
  const q = useApiQuery<Data>(['admin', 'maintenance'], '/admin/maintenance', { refetchInterval: watching ? 3_000 : 30_000 });
  const data = q.data;
  useEffect(() => { setWatching(active(data)); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // The version the page was opened with: when it changes, the update went through.
  const first = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    if (first.current === null) first.current = data.version;
    else if (data.version !== first.current) { toast.success(t('nowRunning', { version: data.version })); first.current = data.version; }
  }, [data?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [data?.agent.log.length]);

  if (!data) return <Section title={t('title')}><p role="status" className="text-sm text-muted">{q.error ? error(q.error) : t('loading')}</p></Section>;
  const r = data.releases;
  const st = data.agent.status;
  const s = data.settings;
  const restarting = watching && !!q.error;

  async function ask(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try { await apiFetch('/admin/maintenance/requests', { method: 'POST', body }); toast.success(done); setWatching(true); client.invalidateQueries({ queryKey: ['admin', 'maintenance'] }); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  const blocked = !manage || !data.agent.installed || watching || busy;
  const elapsed = st?.state === 'running' ? Math.max(0, Math.round((now.getTime() - Date.parse(st.startedAt)) / 1000)) : 0;

  return <Section title={t('title')} description={t('intro')}
    actions={manage && <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" isDisabled={blocked} onPress={() => ask({ action: 'check' }, t('checkQueued'))}><I name="refresh-cw" size={14}/>{t('check')}</Button>
      <Button size="sm" variant="secondary" isDisabled={blocked} onPress={() => ask({ action: 'backup' }, t('backupQueued'))}><I name="archive" size={14}/>{t('backupNow')}</Button>
    </div>}>
    <div className="flex flex-col gap-5">
      {!data.agent.installed && <Notice tone="warning" title={t('agentMissingTitle')}>{t('agentMissing')} <Mono>sudo sh scripts/install.sh agent on</Mono></Notice>}

      <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <Fact label={t('running')}><Mono>{data.version}</Mono>{r?.commit && <span className="ml-1 text-xs text-muted">({r.commit})</span>}</Fact>
        <Fact label={t('channel')}>{t(`channels.${(s.updateChannel ?? 'stable') as 'stable'}`)}{(s.updateChannel === 'edge') && <span className="ml-1 text-xs text-muted">· {s.updateBranch}</span>}</Fact>
        <Fact label={t('state')}>
          {!r ? <StatusChip tone="default">{t('neverChecked')}</StatusChip>
            : r.error ? <StatusChip tone="danger">{error({ code: r.error })}</StatusChip>
            : r.updateAvailable && r.latest !== data.version ? <StatusChip tone="accent">{t('available', { version: r.latest })}</StatusChip>
            : <StatusChip tone="success">{t('upToDate')}</StatusChip>}
        </Fact>
        <Fact label={t('lastCheck')}>{r ? format.relativeTime(new Date(r.checkedAt), now) : '–'}</Fact>
      </dl>

      {r?.updateAvailable && r.latest !== data.version && manage && <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/40 bg-accent-soft/40 p-4">
        <div className="min-w-0">
          <p className="font-semibold">{t('availableTitle', { version: r.latest })}</p>
          <p className="text-sm text-muted">{t('availableHelp')}</p>
        </div>
        <ConfirmButton variant="primary" icon={<I name="download" size={16}/>} label={t('updateNow')} isDisabled={blocked} title={t('confirmTitle', { from: data.version, to: r.latest })}
          body={<ul className="list-disc space-y-1 pl-5">{(['step1', 'step2', 'step3', 'step4', 'step5'] as const).map((k) => <li key={k}>{t(`confirm.${k}`)}</li>)}</ul>}
          confirmLabel={t('updateNow')} cancelLabel={t('cancel')} onConfirm={() => ask({ action: 'update' }, t('updateQueued'))}/>
      </div>}

      <AnimatePresence>
        {(st || data.agent.pending > 0) && <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex flex-col gap-2 rounded-2xl border border-border p-4">
          <div className="flex flex-wrap items-center gap-2">
            {watching && <Spinner size="sm" color="current"/>}
            <p className="font-medium">{data.agent.pending > 0 && st?.state !== 'running' ? t('queued') : st ? t(st.state === 'running' ? `action.${st.action}` : `actionDone.${st.action}`) : ''}</p>
            {st && <StatusChip tone={stateTone[st.state]}>{t(`stateOf.${st.state}`)}</StatusChip>}
            {st?.state === 'running' && <span className="text-xs text-muted tabular-nums">{t('elapsed', { m: Math.floor(elapsed / 60), s: String(elapsed % 60).padStart(2, '0') })}</span>}
            {st && st.state !== 'running' && st.finishedAt && <span className="text-xs text-muted">{format.dateTime(new Date(st.finishedAt), { dateStyle: 'medium', timeStyle: 'short' })}</span>}
          </div>
          {restarting && <Notice tone="warning">{t('restarting')}</Notice>}
          {st?.state === 'failed' && <Notice tone="danger">{t('failed', { code: st.code || String(st.exitCode) })}</Notice>}
          {data.agent.log.length > 0 && <pre ref={logRef} aria-label={t('log')} className="max-h-72 overflow-auto rounded-xl bg-default/60 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{data.agent.log.join('\n')}</pre>}
        </motion.div>}
      </AnimatePresence>

      {!!r?.releases.length && <details className="rounded-2xl border border-border p-4" open={r.updateAvailable}>
        <summary className="cursor-pointer font-medium">{t('releases', { n: r.releases.length })}</summary>
        <ul className="mt-3 flex flex-col divide-y divide-separator">
          {r.releases.map((x) => <li key={x.version} className="flex flex-col gap-1 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Mono>{x.version}</Mono>
              <span className="text-xs text-muted">{format.dateTime(new Date(x.date), { dateStyle: 'medium' })}</span>
              {x.version === r.latest && <StatusChip tone="accent">{t('latest')}</StatusChip>}
              {manage && x.version !== r.latest && r.channel !== 'edge' && <ConfirmButton size="sm" variant="ghost" label={t('switchTo')} isDisabled={blocked}
                title={t('confirmTitle', { from: data.version, to: x.version })} body={t('switchHelp')} confirmLabel={t('switchTo')} cancelLabel={t('cancel')}
                onConfirm={() => ask({ action: 'update', to: x.version }, t('updateQueued'))}/>}
            </div>
            {x.notes && <p className="text-sm whitespace-pre-line text-muted">{x.notes}</p>}
          </li>)}
        </ul>
      </details>}

      {manage && <AutoUpdate settings={s} disabled={blocked} onSave={(body) => ask({ action: 'auto-update', ...body }, t('settingsQueued'))}/>}
    </div>
  </Section>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="rounded-xl bg-default/60 p-3"><dt className="text-xs text-muted">{label}</dt><dd className="mt-1">{children}</dd></div>;
}

function AutoUpdate({ settings: s, disabled, onSave }: { settings: Record<string, string>; disabled: boolean; onSave: (b: { enabled: boolean; channel: string; window: string }) => void }) {
  const t = useTranslations('Updates');
  const [enabled, setEnabled] = useState(s.autoUpdate === 'on');
  const [channel, setChannel] = useState(s.updateChannel ?? 'stable');
  const [window, setWindow] = useState(s.updateWindow ?? '03:00-05:00');
  const valid = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(window);
  const changed = enabled !== (s.autoUpdate === 'on') || channel !== (s.updateChannel ?? 'stable') || window !== (s.updateWindow ?? '03:00-05:00');
  return <div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
    <p className="font-medium">{t('autoTitle')}</p>
    <p className="text-sm text-muted">{t('autoHelp')}</p>
    <div className="grid items-end gap-4 sm:grid-cols-3">
      <SwitchInput label={enabled ? t('autoOn') : t('autoOff')} isSelected={enabled} onChange={setEnabled}/>
      <SelectInput label={t('channel')} value={channel} onChange={(v) => setChannel(v || 'stable')}
        options={(['stable', 'beta', 'edge'] as const).map((c) => ({ id: c, label: t(`channels.${c}`), description: t(`channelHelp.${c}`) }))}/>
      <TextInput label={t('window')} value={window} onChange={setWindow} error={valid ? undefined : t('windowInvalid')} help={t('windowHelp')} spellCheck={false}/>
    </div>
    {s.schedule !== 'on' && enabled && <Notice tone="warning">{t('noTimer')} <Mono>sudo sh scripts/install.sh schedule on</Mono></Notice>}
    <div><Button size="sm" isDisabled={disabled || !valid || !changed} onPress={() => onSave({ enabled, channel, window })}><I name="check" size={14}/>{t('saveAuto')}</Button></div>
  </div>;
}
