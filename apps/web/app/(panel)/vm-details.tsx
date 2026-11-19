"use client";
// Everything VMware knows about the server's VM, grouped: what needs attention first, then hardware, network
// cards (MAC, port, VLAN, addresses), disks, CD drives, VMware Tools, the guest's own network view and, for staff,
// where it runs. Read-only; "Copy all" puts the whole sheet on the clipboard as plain text for a ticket.
import { Button, toast } from '@heroui/react';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { I } from '../../components/icon';
import { Mono, Notice, Section, StatusChip } from '../../components/ui';
import { useErrorText } from '../../lib/api';
import { guestAgent, toolsCommand } from '../../lib/connect';
import { useApiQuery } from '../../lib/query';
import { Copy } from './server-extras';

type Nic = { label: string; adapter: string; mac: string; macType: string; connected: boolean; startConnected: boolean; network: string; kind: string; portKey: string;
  portgroupKey: string; switch: string; vlan: number | null; ips: string[]; guestConnected: boolean | null };
type Disk = { label: string; capacityGb: number; datastore: string; file: string; provisioning: string; mode: string; controller: string; bus: string };
export type VmDetailsData = {
  moref: string; name: string; instanceUuid: string; biosUuid: string; guestId: string; configuredOs: string; hardwareVersion: string; firmware: string; secureBoot: boolean;
  annotation: string; powerState: string; connectionState: string; bootTime: string | null; uptimeSeconds: number; overallStatus: string; consolidationNeeded: boolean; snapshots: number;
  committedGb: number; uncommittedGb: number;
  cpu: { count: number; coresPerSocket: number; hotAdd: boolean; reservationMhz: number; limitMhz: number; shares: number; usageMhz: number };
  memory: { sizeMb: number; hotAdd: boolean; reservationMb: number; limitMb: number; shares: number; guestUsageMb: number; hostUsageMb: number; balloonedMb: number; swappedMb: number };
  nics: Nic[]; disks: Disk[]; cdroms: { label: string; iso: string; connected: boolean }[];
  tools: { status: string; runningStatus: string; version: string; versionStatus: string };
  guest: { hostName: string; os: string; family: string; ips: string[]; gateways: string[]; dns: string[]; domain: string; state: string; heartbeat: string };
  placement: { host: string; cluster: string; resourcePool: string; folder: string; datastores: string[]; vmxPath: string } | null;
  staff: boolean; fetchedAt: string;
};

// Plain values: '–' when empty.
const v = (x: string | number | null | undefined) => (x === null || x === undefined || x === '' ? '–' : String(x));

function Row({ label, value, copy, mono }: { label: string; value: React.ReactNode; copy?: string; mono?: boolean }) {
  return <div className="contents">
    <dt className="text-xs text-muted sm:text-sm">{label}</dt>
    <dd className="flex min-w-0 items-center gap-1 text-sm">
      <span className={`min-w-0 ${mono ? 'break-all font-mono text-[0.85em]' : '[overflow-wrap:anywhere]'}`}>{value}</span>
      {copy && <Copy text={copy} label={label} className="-my-2 shrink-0"/>}
    </dd>
  </div>;
}

function Group({ title, icon, children, open = true }: { title: string; icon: React.ReactNode; children: React.ReactNode; open?: boolean }) {
  return <details open={open} className="group rounded-xl border border-border">
    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 font-medium [&::-webkit-details-marker]:hidden">
      <span aria-hidden className="text-accent">{icon}</span>{title}
      <I name="chevron-down" size={16} className="ml-auto text-muted transition-transform group-open:rotate-180"/>
    </summary>
    <div className="border-t border-separator px-3 py-3">{children}</div>
  </details>;
}

const List = ({ children }: { children: React.ReactNode }) => <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 sm:grid-cols-[minmax(10rem,auto)_minmax(0,1fr)]">{children}</dl>;

// How to get VMware Tools running in this guest: the install command for its distribution, or the Windows route.
export function ToolsHint({ os, platform }: { os: string; platform?: string | null }) {
  const t = useTranslations('VmDetails');
  const agent = guestAgent(platform);
  // The platform is not known (or its agent has no one-line install): say what is missing without guessing a package.
  if (!agent) return <p className="text-xs text-muted">{t('agentNeutral')}</p>;
  const cmd = toolsCommand(os, agent);
  if (!cmd) return <p className="text-xs text-muted">{/windows/i.test(os) ? t(agent === 'qemu' ? 'agentQemuWindows' : 'toolsWindows') : t(agent === 'qemu' ? 'agentQemuOther' : 'toolsOther')}</p>;
  return <div className="flex flex-col gap-1">
    <p className="text-xs text-muted">{t('toolsInstall')}</p>
    <div className="flex items-start gap-1 rounded-lg bg-default/50 px-3 py-2"><code className="min-w-0 flex-1 break-all font-mono text-xs">{cmd}</code><Copy text={cmd} label={t('toolsInstall')} className="-my-1.5 shrink-0"/></div>
  </div>;
}

export function VmDetails({ id, hasVm, platform }: { id: string; hasVm: boolean; platform?: string | null }) {
  const t = useTranslations('VmDetails');
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const { error } = useErrorText();
  const q = useApiQuery<VmDetailsData>(['vm-details', id], hasVm ? `/servers/${id}/details` : null);
  if (!hasVm) return null;
  const d = q.data;
  const yes = (b: boolean) => (b ? t('yes') : t('no'));
  const mb = (n: number) => (n >= 1024 ? `${format.number(n / 1024, { maximumFractionDigits: 1 })} GB` : `${format.number(n)} MB`);
  const limit = (n: number, unit: (x: number) => string) => (n < 0 ? t('unlimited') : unit(n));
  const uptime = (s: number) => { const days = Math.floor(s / 86400), hours = Math.floor((s % 86400) / 3600), minutes = Math.floor((s % 3600) / 60); return t('uptimeValue', { days, hours, minutes }); };
  const label = (group: string, key: string) => (t.has(`${group}.${key}` as 'tools.toolsOk') ? t(`${group}.${key}` as 'tools.toolsOk') : key || '–');

  // What deserves a look, worked out from the details themselves.
  const warnings: string[] = [];
  if (d) {
    if (d.powerState === 'poweredOn' && d.tools.runningStatus !== 'guestToolsRunning') warnings.push(t('warn.toolsNotRunning'));
    if (d.tools.versionStatus === 'guestToolsNeedUpgrade' || d.tools.status === 'toolsOld') warnings.push(t('warn.toolsOld'));
    if (d.memory.balloonedMb > 0 || d.memory.swappedMb > 0) warnings.push(t('warn.memoryPressure', { ballooned: mb(d.memory.balloonedMb), swapped: mb(d.memory.swappedMb) }));
    if (d.consolidationNeeded) warnings.push(t('warn.consolidation'));
    d.nics.filter((n) => d.powerState === 'poweredOn' && !n.connected).forEach((n) => warnings.push(t('warn.nicDisconnected', { nic: n.label })));
    if (d.snapshots >= 3) warnings.push(t('warn.snapshots', { n: d.snapshots }));
    if (d.cdroms.some((c) => c.connected && c.iso)) warnings.push(t('warn.isoMounted'));
  }

  // The whole sheet as text, for a ticket or a note.
  const asText = (x: VmDetailsData) => [
    `${x.name} (${x.moref})`, `${t('instanceUuid')}: ${x.instanceUuid}`, `${t('biosUuid')}: ${x.biosUuid}`,
    `${t('os')}: ${x.guest.os || x.configuredOs}`, `${t('hardwareVersion')}: ${x.hardwareVersion}`, `${t('firmware')}: ${x.firmware}${x.secureBoot ? ' + secure boot' : ''}`,
    `vCPU: ${x.cpu.count} (${x.cpu.coresPerSocket || 1}/socket)`, `RAM: ${mb(x.memory.sizeMb)}`,
    ...x.nics.map((n) => `${n.label}: ${n.adapter} ${n.mac}${n.portKey ? ` port ${n.portKey}` : ''}${n.network ? ` ${n.network}` : ''}${n.vlan != null ? ` VLAN ${n.vlan}` : ''} ${n.ips.join(', ')}`.trim()),
    ...x.disks.map((k) => `${k.label}: ${k.capacityGb} GB ${k.provisioning} ${k.controller}${k.datastore ? ` ${k.datastore}` : ''}`),
    `${t('hostName')}: ${x.guest.hostName}`, `${t('addresses')}: ${x.guest.ips.join(', ')}`, `${t('gateway')}: ${x.guest.gateways.join(', ')}`, `DNS: ${x.guest.dns.join(', ')}`,
    `VMware Tools: ${x.tools.version} (${x.tools.runningStatus})`,
    ...(x.placement ? [`${t('host')}: ${x.placement.host}`, `${t('cluster')}: ${x.placement.cluster}`, `${t('datastores')}: ${x.placement.datastores.join(', ')}`] : []),
  ].join('\n');

  return <Section title={t('title')} description={d ? t('fetched', { when: format.relativeTime(new Date(d.fetchedAt), now) }) : t('help')}
    actions={<>
      {d && <Button size="sm" variant="ghost" onPress={async () => { await navigator.clipboard?.writeText(asText(d)).catch(() => undefined); toast.success(t('copiedAll')); }}>
        <I name="clipboard-copy" size={15}/>{t('copyAll')}</Button>}
      <Button size="sm" variant="ghost" isPending={q.isFetching} onPress={() => void q.refetch()}><I name="refresh-cw" size={15}/>{t('refresh')}</Button>
    </>}>
    {q.error ? <Notice tone="warning">{error(q.error)}</Notice>
      : !d ? <div role="status" aria-label={t('loading')} className="grid gap-3">{[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-default/50"/>)}</div>
      : <div className="flex flex-col gap-3">
        {warnings.length > 0 && <Notice tone="warning" title={t('attention')}><ul className="list-disc pl-5">{warnings.map((w) => <li key={w}>{w}</li>)}</ul></Notice>}

        {/* The facts asked for most, at a glance. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[[t('power'), label('powerState', d.powerState)], [t('uptime'), d.powerState === 'poweredOn' ? uptime(d.uptimeSeconds) : '–'],
            [t('os'), d.guest.os || d.configuredOs || '–'], ['VMware Tools', label('tools', d.tools.status)]].map(([k, x]) =>
            <div key={k} className="min-w-0 rounded-xl bg-default/40 p-3"><p className="text-xs text-muted">{k}</p><p className="truncate text-sm font-medium" title={x}>{x}</p></div>)}
        </div>

        <Group title={t('general')} icon={<I name="info" size={16}/>}>
          <List>
            <Row label={t('vmName')} value={d.name} mono copy={d.name}/>
            <Row label="MoRef" value={d.moref} mono/>
            <Row label={t('instanceUuid')} value={v(d.instanceUuid)} mono copy={d.instanceUuid || undefined}/>
            <Row label={t('biosUuid')} value={v(d.biosUuid)} mono copy={d.biosUuid || undefined}/>
            <Row label={t('configuredOs')} value={`${v(d.configuredOs)}${d.guestId ? ` (${d.guestId})` : ''}`}/>
            <Row label={t('hardwareVersion')} value={v(d.hardwareVersion)}/>
            <Row label={t('firmware')} value={`${d.firmware === 'efi' ? 'UEFI' : d.firmware === 'bios' ? 'BIOS' : v(d.firmware)}${d.secureBoot ? ` · ${t('secureBoot')}` : ''}`}/>
            <Row label={t('bootTime')} value={d.bootTime ? format.dateTime(new Date(d.bootTime), { dateStyle: 'medium', timeStyle: 'short' }) : '–'}/>
            <Row label={t('snapshots')} value={format.number(d.snapshots)}/>
            <Row label={t('storageUsed')} value={t('storageValue', { committed: format.number(d.committedGb, { maximumFractionDigits: 1 }), uncommitted: format.number(d.uncommittedGb, { maximumFractionDigits: 1 }) })}/>
            <Row label={t('health')} value={<StatusChip tone={d.overallStatus === 'green' ? 'success' : d.overallStatus === 'red' ? 'danger' : d.overallStatus === 'yellow' ? 'warning' : 'default'}>{label('status', d.overallStatus)}</StatusChip>}/>
            {d.annotation && <Row label={t('annotation')} value={d.annotation}/>}
          </List>
        </Group>

        <Group title={t('cpuMemory')} icon={<I name="cpu" size={16}/>}>
          <List>
            <Row label="vCPU" value={t('cpuValue', { count: d.cpu.count, sockets: Math.max(1, Math.round(d.cpu.count / Math.max(1, d.cpu.coresPerSocket || 1))), cores: d.cpu.coresPerSocket || 1 })}/>
            <Row label={t('cpuUsage')} value={`${format.number(d.cpu.usageMhz)} MHz`}/>
            <Row label={t('cpuAllocation')} value={t('allocationValue', { reservation: `${format.number(d.cpu.reservationMhz)} MHz`, limit: limit(d.cpu.limitMhz, (n) => `${format.number(n)} MHz`), shares: format.number(d.cpu.shares) })}/>
            <Row label={t('hotAdd')} value={t('hotAddValue', { cpu: yes(d.cpu.hotAdd), memory: yes(d.memory.hotAdd) })}/>
            <Row label={t('memory')} value={mb(d.memory.sizeMb)}/>
            <Row label={t('memoryUsage')} value={t('memoryUsageValue', { guest: mb(d.memory.guestUsageMb), host: mb(d.memory.hostUsageMb) })}/>
            <Row label={t('memoryAllocation')} value={t('allocationValue', { reservation: mb(d.memory.reservationMb), limit: limit(d.memory.limitMb, mb), shares: format.number(d.memory.shares) })}/>
            <Row label={t('memoryPressure')} value={t('memoryPressureValue', { ballooned: mb(d.memory.balloonedMb), swapped: mb(d.memory.swappedMb) })}/>
          </List>
        </Group>

        <Group title={t('nics', { n: d.nics.length })} icon={<I name="network" size={16}/>}>
          {d.nics.length === 0 ? <p className="text-sm text-muted">{t('noNics')}</p> : <div className="flex flex-col gap-3">{d.nics.map((n) =>
            <div key={n.mac || n.label} className="rounded-lg bg-default/30 p-3">
              <p className="mb-2 flex flex-wrap items-center gap-2 text-sm font-medium">{n.label}<StatusChip tone="default">{n.adapter}</StatusChip>
                <StatusChip tone={n.connected ? 'success' : 'warning'}>{n.connected ? t('connected') : t('disconnected')}</StatusChip></p>
              <List>
                <Row label="MAC" value={n.mac} mono copy={n.mac}/>
                <Row label={t('macType')} value={label('macTypes', n.macType)}/>
                <Row label={t('port')} value={n.portKey ? n.portKey : t('portStandard')} mono={!!n.portKey} copy={n.portKey || undefined}/>
                {d.staff && <Row label={t('network')} value={`${v(n.network)}${n.kind ? ` · ${label('kinds', n.kind)}` : ''}`}/>}
                {d.staff && <Row label="VLAN" value={n.vlan == null ? '–' : n.vlan === 0 ? t('untagged') : String(n.vlan)}/>}
                {d.staff && n.switch && <Row label={t('switch')} value={n.switch} mono/>}
                {d.staff && n.portgroupKey && <Row label={t('portgroupKey')} value={n.portgroupKey} mono/>}
                <Row label={t('atBoot')} value={yes(n.startConnected)}/>
                <Row label={t('guestLink')} value={n.guestConnected == null ? '–' : n.guestConnected ? t('up') : t('down')}/>
                <Row label={t('addresses')} value={n.ips.length ? n.ips.join(', ') : '–'} mono copy={n.ips.length ? n.ips.map((x) => x.split('/')[0]).join(' ') : undefined}/>
              </List>
            </div>)}</div>}
        </Group>

        <Group title={t('disks', { n: d.disks.length })} icon={<I name="hard-drive" size={16}/>}>
          {d.disks.length === 0 ? <p className="text-sm text-muted">–</p> : <div className="flex flex-col gap-3">{d.disks.map((k) =>
            <div key={k.label + k.controller} className="rounded-lg bg-default/30 p-3">
              <p className="mb-2 flex flex-wrap items-center gap-2 text-sm font-medium">{k.label}<StatusChip tone="default">{format.number(k.capacityGb, { maximumFractionDigits: 1 })} GB</StatusChip></p>
              <List>
                <Row label={t('provisioning')} value={label('provisionings', k.provisioning)}/>
                <Row label={t('diskMode')} value={label('modes', k.mode)}/>
                <Row label={t('controller')} value={`${v(k.controller)}${k.bus ? ` · ${k.bus}` : ''}`}/>
                {d.staff && <Row label={t('datastore')} value={v(k.datastore)}/>}
                {d.staff && k.file && <Row label={t('file')} value={k.file} mono copy={k.file}/>}
              </List>
            </div>)}</div>}
        </Group>

        {d.cdroms.length > 0 && <Group title={t('cdroms')} icon={<I name="disc" size={16}/>} open={d.cdroms.some((c) => c.iso)}>
          <List>{d.cdroms.map((c) => <Row key={c.label} label={c.label} value={c.iso ? `${c.iso} · ${c.connected ? t('connected') : t('disconnected')}` : t('empty')}/>)}</List>
        </Group>}

        <Group title={t('guestNetwork')} icon={<I name="globe" size={16}/>}>
          <List>
            <Row label={t('hostName')} value={v(d.guest.hostName)} mono copy={d.guest.hostName || undefined}/>
            <Row label={t('addresses')} value={d.guest.ips.length ? d.guest.ips.join(', ') : '–'} mono copy={d.guest.ips.length ? d.guest.ips.join(' ') : undefined}/>
            <Row label={t('gateway')} value={d.guest.gateways.length ? d.guest.gateways.join(', ') : '–'} mono/>
            <Row label="DNS" value={d.guest.dns.length ? d.guest.dns.join(', ') : '–'} mono/>
            <Row label={t('domain')} value={v(d.guest.domain)}/>
            <Row label={t('heartbeat')} value={label('status', d.guest.heartbeat)}/>
          </List>
          {d.guest.ips.length === 0 && d.powerState === 'poweredOn' && <p className="mt-2 text-xs text-muted">{t('noGuestInfo')}</p>}
        </Group>

        <Group title="VMware Tools" icon={<I name="wrench" size={16}/>} open={warnings.length > 0}>
          <List>
            <Row label={t('toolsStatus')} value={label('tools', d.tools.status)}/>
            <Row label={t('toolsRunning')} value={label('running', d.tools.runningStatus)}/>
            <Row label={t('toolsVersion')} value={`${v(d.tools.version)}${d.tools.versionStatus ? ` · ${label('versions', d.tools.versionStatus)}` : ''}`}/>
          </List>
          {d.powerState === 'poweredOn' && d.tools.runningStatus !== 'guestToolsRunning' && <div className="mt-3"><ToolsHint os={`${d.guest.os || d.configuredOs} ${d.guestId}`} platform={platform}/></div>}
        </Group>

        {d.placement && <Group title={t('placement')} icon={<I name="server" size={16}/>}>
          <List>
            <Row label={t('host')} value={v(d.placement.host)} copy={d.placement.host || undefined}/>
            <Row label={t('cluster')} value={v(d.placement.cluster)}/>
            <Row label={t('resourcePool')} value={v(d.placement.resourcePool)}/>
            <Row label={t('folder')} value={v(d.placement.folder)}/>
            <Row label={t('datastores')} value={d.placement.datastores.length ? d.placement.datastores.join(', ') : '–'}/>
            <Row label={t('vmx')} value={v(d.placement.vmxPath)} mono copy={d.placement.vmxPath || undefined}/>
          </List>
        </Group>}
      </div>}
  </Section>;
}
