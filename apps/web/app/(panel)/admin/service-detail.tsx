"use client";
// One service of the stack in detail (Admin → System → Server state → Services → a service): its state and what that
// means, health, exit code, start and end, restarts, image and version, ports, what to do about it, a restart (or a
// one-shot job run again) through the host agent, and the last lines of its log. The API decides what may be
// restarted (apps/api/src/host-services.ts) and masks secrets in the lines; the lines are read for as long as the
// drawer is open and dropped from the browser's memory when it closes (no cache beyond the view).
import { Button, Drawer, Spinner, toast } from '@heroui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { I } from '../../../components/icon';
import { ConfirmButton, Mono, Notice, StatusChip, type Tone } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { useMe } from '../../../lib/me';
import { can } from '../../../lib/permissions';

export type Kind = 'running' | 'healthy' | 'starting' | 'unhealthy' | 'restarting' | 'completed' | 'failed' | 'stopped' | 'created' | 'paused';
export type ServiceRow = {
  service: string; state: string; health: string; status: string; cpu: number; memory: string; memoryPercent: number; restarts: number; startedAt: string;
  finishedAt?: string; exitCode: number | null; restartPolicy?: string; image?: string; imageVersion?: string; ports?: string; managed?: number;
  kind: Kind; fault: boolean; oneShot: boolean;
  version: { panel: true; version: string; commit: string } | { panel: false; tag: string; label: string; reported: string };
  rule: { restart: boolean; run: boolean; refused: '' | 'SERVICE_PROTECTED' | 'SERVICE_ONE_SHOT' | 'SERVICE_NOT_MANAGED'; interrupts: 'panel' | 'operations' | 'terminal' | 'none' };
};
type Run = { id: string; action: string; state: 'running' | 'succeeded' | 'failed' | 'rejected'; startedAt: string; finishedAt: string; exitCode: number | null; code: string };
type Detail = { checkedAt: string; service: ServiceRow; logs: string[] | null; agent: { installed: boolean; busy: boolean; status: Run | null; log: string[] } };

export const kindTone: Record<Kind, Tone> = { running: 'success', healthy: 'success', starting: 'accent', completed: 'default', unhealthy: 'danger', restarting: 'danger', failed: 'danger', stopped: 'danger', created: 'warning', paused: 'warning' };
export const lineTone = (l: string) => (/\b(error|fatal|panic|critical|emerg|"level":"(error|fatal)")\b/i.test(l) ? 'text-danger' : /\b(warn|warning|"level":"warn")\b/i.test(l) ? 'text-warning' : '');
// What the version column says: the panel's version (and commit) for what is built here, else the version the
// service reports, the version its image's label states, or its image tag. Never "unknown" while a tag is there.
export function versionText(v: ServiceRow['version']) {
  if (v.panel) return v.commit && !v.version.includes(v.commit) ? `${v.version} (${v.commit})` : v.version;
  return v.reported || v.label || v.tag || '–';
}
const healthChecked = ['api', 'web', 'worker', 'postgres', 'redis', 'console', 'terminal', 'vmware', 'proxmox', 'xcpng', 'ovirt', 'hyperv', 'libvirt', 'incus'];
const never = (iso?: string) => !iso || iso.startsWith('0001-');

export function ServiceDrawer({ name, onClose }: { name: string | null; onClose: () => void }) {
  const t = useTranslations('HostState');
  return <Drawer>
    <Drawer.Backdrop isOpen={!!name} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Drawer.Content placement="right">
        <Drawer.Dialog aria-label={name ? t('svc.title', { service: name }) : t('svc.titleEmpty')} className="w-[min(100vw,36rem)] max-w-full" data-testid="service-detail">
          <Drawer.CloseTrigger/>
          {name && <ServiceBody name={name}/>}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  </Drawer>;
}

function ServiceBody({ name }: { name: string }) {
  const t = useTranslations('HostState');
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const { error, code: codeText } = useErrorText();
  const me = useMe();
  const client = useQueryClient();
  const manage = can(me?.permissions, 'system.update');
  const [watching, setWatching] = useState(false);
  const [asking, setAsking] = useState(false);
  // gcTime 0: the answer (with its log lines) leaves the browser's memory as soon as the drawer closes.
  const q = useQuery<Detail>({ queryKey: ['admin', 'host-service', name], queryFn: ({ signal }) => apiFetch<Detail>(`/admin/host/services/${encodeURIComponent(name)}?lines=200`, { signal }),
    gcTime: 0, staleTime: 0, refetchInterval: watching ? 3_000 : 15_000, retry: watching ? 3 : 1 });
  const d = q.data;
  useEffect(() => { if (d && !d.agent.busy && d.agent.status?.state !== 'running') setWatching(false); }, [d]);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [d?.logs?.length, d?.checkedAt]);

  if (!d) return <Drawer.Body className="py-6"><p role="status" className="text-sm text-muted">{q.error ? error(q.error) : t('loading')}</p></Drawer.Body>;
  const s = d.service;
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'medium' });
  const ago = (iso: string) => format.relativeTime(new Date(Math.min(Date.parse(iso), now.getTime())), now);
  const run = d.agent.status;
  const mine = run && d.agent.log.some((l) => l.includes(name));
  const ended = s.kind === 'completed' || s.kind === 'failed' || s.kind === 'stopped';

  async function ask(act: 'restart' | 'run') {
    try {
      await apiFetch('/admin/maintenance/requests', { method: 'POST', body: { action: 'service', service: name, act } });
      toast.success(t(act === 'run' ? 'svc.runQueued' : 'svc.restartQueued', { service: name }));
      setWatching(true);
      for (const queryKey of [['admin', 'host-service', name], ['admin', 'host-live'], ['admin', 'maintenance']]) void client.invalidateQueries({ queryKey });
    } catch (e) { toast.danger(error(e)); throw e; }
  }
  // The log again: the agent takes a fresh snapshot (a few seconds), then the drawer reads it.
  async function refreshLog() {
    setAsking(true);
    try { await apiFetch('/admin/host/state', { method: 'POST' }); toast.success(t('asked')); }
    catch (e) { toast.danger(error(e)); setAsking(false); return; }
    setTimeout(() => { setAsking(false); void q.refetch(); void client.invalidateQueries({ queryKey: ['admin', 'host-live'] }); }, 10_000);
  }
  const blocked = !manage || !d.agent.installed || d.agent.busy || watching;
  const facts: [string, React.ReactNode][] = [
    [t('svc.docker'), <span key="k" className="font-mono text-xs [overflow-wrap:anywhere]">{s.status || s.state}</span>],
    [t('svc.health'), s.health ? t(`svc.healthOf.${s.health as 'healthy'}`) : t('svc.noHealth')],
    ...(ended || (s.exitCode !== null && s.exitCode !== 0) ? [[t('svc.exitCode'), <Mono key="e">{String(s.exitCode ?? '–')}</Mono>] as [string, React.ReactNode]] : []),
    [t('svc.started'), never(s.startedAt) ? '–' : <span key="s" title={when(s.startedAt)}>{ago(s.startedAt)}</span>],
    ...(ended && !never(s.finishedAt) ? [[t('svc.finished'), <span key="f" title={when(s.finishedAt!)}>{ago(s.finishedAt!)}</span>] as [string, React.ReactNode]] : []),
    [t('svc.restartCount'), String(s.restarts ?? 0)],
    [t('svc.image'), <span key="i" className="font-mono text-xs [overflow-wrap:anywhere]">{s.image || '–'}</span>],
    [t('svc.version'), <span key="v" className="[overflow-wrap:anywhere]">{versionText(s.version)}{s.version.panel ? <span className="block text-xs text-muted">{t('svc.panelVersion')}</span>
      : s.version.reported ? <span className="block text-xs text-muted">{t('svc.reported', { tag: s.version.tag })}</span> : null}</span>],
    [t('svc.ports'), <span key="p" className="font-mono text-xs [overflow-wrap:anywhere]">{s.ports || t('svc.noPorts')}</span>],
  ];
  const confirm = (act: 'restart' | 'run') => <div className="flex flex-col gap-2">
    <p>{act === 'run' ? t('svc.runBody', { service: name }) : t(`svc.interrupts.${s.rule.interrupts}`, { service: name })}</p>
    <p>{t('svc.audited')}</p>
  </div>;

  return <>
    <Drawer.Header className="flex flex-col gap-2 pr-12">
      <Drawer.Heading className="flex flex-wrap items-center gap-2 text-lg font-semibold"><span className="font-mono">{name}</span>
        <StatusChip tone={kindTone[s.kind]}>{t(`kind.${s.kind}`)}</StatusChip>{s.oneShot && <StatusChip tone="default">{t('svc.oneShot')}</StatusChip>}</Drawer.Heading>
      <p className="text-xs text-muted">{t('snapshot', { when: ago(d.checkedAt) })}</p>
    </Drawer.Header>
    <Drawer.Body className="flex flex-col gap-5 pb-8">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm min-[420px]:grid-cols-2">
        {facts.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-xs text-muted">{k}</dt><dd className="mt-0.5">{v}</dd></div>)}
      </dl>

      <Notice tone={s.fault ? 'danger' : s.kind === 'starting' ? 'accent' : 'default'} title={t('svc.meaningTitle')}>
        <p>{t(`meaning.${s.kind}`, { code: String(s.exitCode ?? '') })}</p>
        <p className="mt-2 font-medium">{t('svc.todoTitle')}</p>
        <p>{t(`todo.${s.kind}`, { service: name })}</p>
        {(s.kind === 'unhealthy' || s.kind === 'starting') && <p className="mt-2">{healthChecked.includes(name) ? t(`hc.${name as 'api'}`) : t('hc.other')}</p>}
        {s.kind === 'restarting' && <p className="mt-2">{t('svc.loopCauses')}</p>}
      </Notice>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t('svc.actions')}</h3>
        {!manage ? <p className="text-sm text-muted">{t('svc.needsPermission')}</p>
          : !d.agent.installed ? <Notice tone="warning">{t('agentMissing')}</Notice>
          : s.rule.restart || s.rule.run ? <div className="flex flex-wrap items-center gap-2">
            {s.rule.restart && <ConfirmButton size="sm" variant="danger-soft" icon={<I name="rotate-ccw" size={14}/>} label={t('svc.restart')} isDisabled={blocked}
              title={t('svc.restartTitle', { service: name })} body={confirm('restart')} confirmLabel={t('svc.restart')} cancelLabel={t('svc.cancel')} onConfirm={() => ask('restart')}/>}
            {s.rule.run && <ConfirmButton size="sm" variant="primary" icon={<I name="play" size={14}/>} label={t('svc.runAgain')} isDisabled={blocked}
              title={t('svc.runTitle', { service: name })} body={confirm('run')} confirmLabel={t('svc.runAgain')} cancelLabel={t('svc.cancel')} onConfirm={() => ask('run')}/>}
            {d.agent.busy && !watching && <span className="text-xs text-muted">{t('svc.otherTask')}</span>}
          </div>
          : <p className="text-sm text-muted" data-testid="service-refused">{t(`svc.refused.${s.rule.refused || 'SERVICE_ONE_SHOT'}`, { service: name })}</p>}
        {watching && <p role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner size="sm" color="current"/>{s.rule.interrupts === 'panel' ? t('svc.waitingPanel') : t('svc.waiting')}</p>}
        {watching && q.isError && <Notice tone="warning">{t('svc.panelAway')}</Notice>}
        {run && mine && run.state !== 'running' && <Notice tone={run.state === 'succeeded' ? 'success' : 'danger'} title={run.state === 'succeeded' ? t('svc.lastOk') : t('svc.lastFailed', { code: run.code ? codeText(run.code) : run.state })}>
          <span className="text-xs">{format.dateTime(new Date(run.finishedAt || run.startedAt), { dateStyle: 'medium', timeStyle: 'short' })}</span>
          {d.agent.log.length > 0 && <pre className="mt-1 max-h-32 overflow-auto font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{d.agent.log.slice(-5).join('\n')}</pre>}
        </Notice>}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t('svc.log')}</h3>
          {d.logs !== null && d.agent.installed && <Button size="sm" variant="ghost" isPending={asking} isDisabled={d.agent.busy} onPress={() => void refreshLog()}><I name="refresh-cw" size={14}/>{t('refresh')}</Button>}
        </div>
        {d.logs === null ? <p className="text-sm text-muted">{t('svc.logAdminOnly')}</p> : <>
          <pre ref={box} tabIndex={0} aria-label={t('logsOf', { source: name })} className="max-h-80 min-h-24 overflow-auto rounded-xl border border-border bg-default/40 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
            {d.logs.length ? d.logs.map((l, i) => <span key={i} className={`block ${lineTone(l)}`}>{l}</span>) : <span className="text-muted">{t('logEmpty')}</span>}
          </pre>
          <p className="text-xs text-muted">{t('svc.logHelp', { n: d.logs.length })}</p>
        </>}
      </div>
    </Drawer.Body>
  </>;
}
