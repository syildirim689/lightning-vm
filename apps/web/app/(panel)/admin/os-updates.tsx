"use client";
// Admin → System → Operating system updates: what waits on the panel's own server (and what of it is a security
// update), whether a restart is needed, automatic security updates, and the restart itself. The API only drops a
// request; the host agent (scripts/install.sh os) checks it again, runs apt and records the result for this page.
import { Button, Chip, SearchField, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { startHostTask } from '../../../components/host-task';
import { I } from '../../../components/icon';
import { ConfirmButton, Mono, Notice, Section, StatusChip, SwitchInput, type Tone } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { useMe } from '../../../lib/me';
import { can } from '../../../lib/permissions';
import { fold } from '../../../lib/search';
import { agentRunning } from '../../../lib/agent';
import { useApiQuery } from '../../../lib/query';

type Pkg = { name: string; to: string; from: string; security: boolean };
type Os = { checkedAt: string; manager: 'apt' | 'none'; total: number; security: number; held: number; packages: Pkg[]; rebootRequired: boolean; rebooted: boolean; rebootPackages: string;
  autoSecurity: boolean; listsAt: string; changedAt: string; kernel: string };
type Status = { id: string; state: 'running' | 'succeeded' | 'failed' | 'rejected'; startedAt: string; code: string };
type Data = { os: Os | null; uptime: number; agent: { installed: boolean; pending: number; status: Status | null; log: string[]; setUp?: number } };
type Act = 'check' | 'upgrade' | 'security' | 'reboot' | 'auto-on' | 'auto-off';
const stateTone: Record<Status['state'], Tone> = { running: 'accent', succeeded: 'success', failed: 'danger', rejected: 'danger' };
// Packages whose update restarts the containers the panel runs in.
const restartsPanel = (p: Pkg) => /^(docker|containerd|runc)/.test(p.name);

export default function OsUpdates() {
  const t = useTranslations('OsUpdates');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { error, code: codeText } = useErrorText();
  const me = useMe();
  const client = useQueryClient();
  const manage = can(me?.permissions, 'system.update');
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [find, setFind] = useState('');
  const [only, setOnly] = useState(false);
  // After a restart was asked for, the page keeps asking until the server answers again.
  const [restarting, setRestarting] = useState(false);
  const q = useApiQuery<Data>(['admin', 'os'], '/admin/os', { refetchInterval: watching || restarting ? 3_000 : 60_000 });
  const d = q.data;
  useEffect(() => { setWatching(!!d && (d.agent.pending > 0 || agentRunning(d.agent.status))); }, [d]);
  // Back after the restart: the uptime started again.
  const down = useRef(false);
  useEffect(() => {
    if (!restarting) return;
    if (q.error) down.current = true;
    else if (d && (down.current || d.os?.rebooted) && d.uptime < 900) { down.current = false; setRestarting(false); }
  }, [restarting, q.error, d]); // eslint-disable-line react-hooks/exhaustive-deps

  // The progress window finished: read the new state at once.
  useEffect(() => {
    const done = () => { setRestarting(false); void client.invalidateQueries({ queryKey: ['admin', 'os'] }); };
    window.addEventListener('lvm:host-task-done', done);
    return () => window.removeEventListener('lvm:host-task-done', done);
  }, [client]);

  async function ask(act: Act, done: string) {
    setBusy(true);
    try {
      await apiFetch('/admin/os', { method: 'POST', body: { act } });
      // A restart and an install get the progress window (components/host-task.tsx); the quick ones a line.
      if (act === 'reboot' || act === 'security' || act === 'upgrade') startHostTask(act, d?.agent.status?.id ?? null, act === 'security' ? d?.os?.security ?? 0 : act === 'upgrade' ? d?.os?.total ?? 0 : 0);
      else toast.success(done);
      setWatching(true); if (act === 'reboot') setRestarting(true); void client.invalidateQueries({ queryKey: ['admin', 'os'] });
    }
    catch (e) { toast.danger(error(e)); throw e; } finally { setBusy(false); }
  }
  // The recorded state is from before the last restart, or was never taken: take it once, quietly.
  const asked = useRef(false);
  const stale = !!d && d.agent.installed && (!d.os || d.os.rebooted) && !watching;
  useEffect(() => {
    if (!stale || !manage || asked.current || busy || restarting) return;
    asked.current = true;
    // The agent takes one request at a time: when another quiet request of this page got there first (the host
    // state's snapshot), this one is refused. It is asked once more a little later instead of being dropped.
    const check = () => apiFetch('/admin/os', { method: 'POST', body: { act: 'check' } }).then(() => { setWatching(true); void client.invalidateQueries({ queryKey: ['admin', 'os'] }); });
    void check().catch(() => { setTimeout(() => void check().catch(() => undefined), 15_000); });
  }, [stale, manage, busy, restarting, client]);

  if (!d) return <Section title={t('title')}><p role="status" className="text-sm text-muted">{q.error && !restarting ? error(q.error) : restarting ? t('restarting') : '…'}</p></Section>;
  const o = d.os;
  const st = d.agent.status;
  const blocked = !manage || !d.agent.installed || watching || busy || restarting;
  const days = Math.floor(d.uptime / 86400), hours = Math.floor((d.uptime % 86400) / 3600);
  const ago = (iso: string) => (iso ? format.relativeTime(new Date(Math.min(Date.parse(iso), now.getTime())), now) : '–');
  const listsOld = !!o?.listsAt && now.getTime() - Date.parse(o.listsAt) > 3 * 86_400_000;
  const needle = fold(find.trim());
  const shown = (o?.packages ?? []).filter((p) => (!only || p.security) && (!needle || fold(p.name).includes(needle)));
  const panelRestarts = (o?.packages ?? []).some(restartsPanel);
  const upgradeBody = (security: boolean) => <div className="flex flex-col gap-2">
    <p>{security ? t('securityBody', { n: o?.security ?? 0 }) : t('upgradeBody', { n: o?.total ?? 0 })}</p>
    {(security ? (o?.packages ?? []).filter((p) => p.security).some(restartsPanel) : panelRestarts) && <p className="text-warning">{t('dockerWarning')}</p>}
    <p>{t('keepsConfig')}</p>
  </div>;

  return <Section title={t('title')} description={t('intro')}
    actions={manage && <Button size="sm" variant="secondary" isDisabled={blocked} onPress={() => void ask('check', t('checkQueued')).catch(() => undefined)}><I name="refresh-cw" size={14}/>{t('check')}</Button>}>
    <div className="flex flex-col gap-5">
      {!d.agent.installed && <Notice tone="warning" title={t('agentMissingTitle')}>{t('agentMissing')} <Mono>sudo sh scripts/install.sh agent on</Mono></Notice>}
      {restarting && <div role="status"><Notice tone="warning" title={t('restartingTitle')}>{t('restarting')}</Notice></div>}
      {o?.manager === 'none' && <Notice tone="default">{t('unsupported')}</Notice>}

      {o && o.manager !== 'none' && <>
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label={t('waiting')} value={format.number(o.total)} tone={o.total ? 'accent' : 'success'} hint={o.total ? t('waitingHint') : t('upToDate')}/>
          <Tile label={t('securityCount')} value={format.number(o.security)} tone={o.security ? 'danger' : 'success'} hint={o.security ? t('securityHint') : t('noSecurity')}/>
          <Tile label={t('restart')} value={o.rebootRequired ? t('restartNeeded') : t('restartNotNeeded')} tone={o.rebootRequired ? 'warning' : 'success'} hint={t('uptime', { days, hours })}/>
          <Tile label={t('auto')} value={o.autoSecurity ? t('autoOn') : t('autoOff')} tone={o.autoSecurity ? 'success' : 'warning'} hint={o.autoSecurity ? t('autoOnHint') : t('autoOffHint')}/>
        </dl>

        {o.security > 0 && <Notice tone="danger" title={t('securityTitle', { n: o.security })}>{o.autoSecurity ? t('securityAutoSoon') : t('securityNow')}</Notice>}
        {o.rebootRequired && <Notice tone="warning" title={t('restartTitle')}>{t('restartWhy')}{o.rebootPackages && <> <span className="text-muted">({o.rebootPackages.split(',').join(', ')})</span></>}</Notice>}
        {listsOld && <Notice tone="default">{t('listsOld', { when: ago(o.listsAt) })}</Notice>}

        {manage && <div className="flex flex-col gap-4 rounded-2xl border border-border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ConfirmButton variant="primary" icon={<I name="shield-check" size={16}/>} label={t('installSecurity', { n: o.security })} isDisabled={blocked || !o.security}
              title={t('installSecurityTitle')} body={upgradeBody(true)} confirmLabel={t('install')} cancelLabel={t('cancel')} onConfirm={() => ask('security', t('queued'))}/>
            <ConfirmButton variant="secondary" icon={<I name="download" size={16}/>} label={t('installAll', { n: o.total })} isDisabled={blocked || !o.total}
              title={t('installAllTitle')} body={upgradeBody(false)} confirmLabel={t('install')} cancelLabel={t('cancel')} onConfirm={() => ask('upgrade', t('queued'))}/>
            <ConfirmButton variant={o.rebootRequired ? 'danger' : 'danger-soft'} icon={<I name="rotate-ccw" size={16}/>} label={t('restartNow')} isDisabled={blocked}
              title={t('restartConfirmTitle')} body={<div className="flex flex-col gap-2"><p>{t('restartBody')}</p><p>{t('restartVms')}</p></div>}
              confirmLabel={t('restartNow')} cancelLabel={t('cancel')} onConfirm={() => ask('reboot', t('restartQueued'))}/>
          </div>
          <SwitchInput label={<span className="flex flex-col"><span>{t('autoSwitch')}</span><span className="text-xs font-normal text-muted">{t('autoHelp')}</span></span>}
            isSelected={o.autoSecurity} isDisabled={blocked} onChange={(on) => void ask(on ? 'auto-on' : 'auto-off', t(on ? 'autoTurningOn' : 'autoTurningOff')).catch(() => undefined)}/>
        </div>}

        {o.packages.length > 0 && <details className="rounded-2xl border border-border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{t('packages', { n: o.total })}{o.held > 0 && <span className="ml-2 font-normal text-muted">{t('held', { n: o.held })}</span>}</summary>
          <div className="flex flex-col gap-3 border-t border-separator p-4">
            <div className="flex flex-wrap items-center gap-2">
              {o.packages.length > 8 && <SearchField aria-label={t('findPackage')} value={find} onChange={setFind} className="w-full sm:w-64">
                <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('findPackage')}/><SearchField.ClearButton/></SearchField.Group></SearchField>}
              {o.security > 0 && o.security < o.total && <button type="button" aria-pressed={only} onClick={() => setOnly(!only)}
                className={`flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs transition-colors ${only ? 'border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border hover:border-accent'}`}>
                <I name="shield-check" size={13}/>{t('onlySecurity')}</button>}
            </div>
            {!shown.length ? <p className="text-sm text-muted">{t('noPackageMatch')}</p> : <ul className="flex max-h-80 flex-col divide-y divide-separator overflow-auto text-sm">
              {shown.map((p) => <li key={p.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                <span className="min-w-0 flex-1 break-all font-mono text-xs">{p.name}</span>
                <span className="font-mono text-xs text-muted">{p.from} → <span className="text-foreground">{p.to}</span></span>
                {p.security && <StatusChip tone="danger">{t('securityChip')}</StatusChip>}
                {restartsPanel(p) && <StatusChip tone="warning">{t('panelChip')}</StatusChip>}
              </li>)}</ul>}
            {o.total > o.packages.length && <p className="text-xs text-muted">{t('more', { n: o.total - o.packages.length })}</p>}
          </div>
        </details>}

        <p className="text-xs text-muted">{t('recorded', { when: ago(o.checkedAt) })} · {t('listsAt', { when: ago(o.listsAt) })}{o.changedAt && <> · {t('changedAt', { when: ago(o.changedAt) })}</>} · {t('kernel')} <Mono>{o.kernel}</Mono></p>
      </>}
      {d.agent.installed && !o && <Notice tone="default">{t('noDetails')}</Notice>}

      {st && <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm"><span className="font-medium">{t('lastRun')}</span><StatusChip tone={stateTone[st.state]}>{t(`state.${st.state}`)}</StatusChip>
          {st.code && st.state !== 'running' && st.state !== 'succeeded' && <Chip size="sm" variant="soft">{codeText(st.code)}</Chip>}</div>
        {d.agent.log.length > 0 && <pre className="max-h-48 overflow-auto rounded-xl bg-default/60 p-3 font-mono text-xs leading-relaxed">{d.agent.log.join('\n')}</pre>}
      </div>}
    </div>
  </Section>;
}

function Tile({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint: string; tone: 'accent' | 'success' | 'warning' | 'danger' }) {
  const color = { accent: 'text-accent', success: 'text-success', warning: 'text-warning', danger: 'text-danger' }[tone];
  return <div className="rounded-xl border border-border px-3 py-2.5"><dt className="text-xs text-muted">{label}</dt>
    <dd className={`mt-0.5 text-lg font-semibold tabular-nums ${color}`}>{value}</dd><dd className="text-xs text-muted">{hint}</dd></div>;
}
