"use client";
import { Breadcrumbs, Button, Card, ProgressBar, SearchField, Tabs } from '@heroui/react';
import { I } from '../../../../../components/icon';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { apiFetch, useErrorText } from '../../../../../lib/api';
import { useApiAction, useApiQuery } from '../../../../../lib/query';
import { supports } from '../../../../../components/capabilities';
import { ButtonLink, ConfirmButton, DataTable, Notice, PageHeader, Section, Stat, StatusChip, TextInput } from '../../../../../components/ui';
import { apiVersions, versionLabel, type Connection } from '../connections';
import { SelectInput } from '../../../../../components/ui';
import { downloadCsv } from '../../../../../lib/csv';
import { fold } from '../../../../../lib/note-line';

// Tab label with its count beside it.
const Count = ({ n }: { n: number }) => <span className="ml-1.5 rounded-full bg-default px-1.5 text-xs tabular-nums">{n}</span>;

type Row = Record<string, string | number | boolean | null | string[]>;
type Detail = { connection: Connection; capacity: Record<string, number>; hosts: Row[]; datastores: Row[]; networks: Row[]; compute: Row[]; vms: Row[] };

// Moves every panel server off this host to the other hosts of its cluster (before maintenance), without stopping them.
function Evacuate({ connectionId, host, name }: { connectionId: string; host: string; name: string }) {
  const t = useTranslations('Vmware');
  const go = useApiAction(() => apiFetch<{ started: string[]; skipped: { name: string; reason: string }[] }>(`/admin/vmware/connections/${connectionId}/hosts/${host}/evacuate`, { method: 'POST' }),
    { invalidate: [['admin']], success: (r) => t('evacuated', { started: r.started.length, skipped: r.skipped.length }) });
  return <ConfirmButton size="sm" variant="ghost" icon={<I name="truck" size={14}/>} label={t('evacuate')} title={t('evacuateTitle', { name })} body={t('evacuateBody')}
    confirmLabel={t('evacuate')} cancelLabel={t('cancel')} isDisabled={go.isPending} onConfirm={() => go.mutate()}/>;
}

export default function ConnectionDetail({ id }: { id: string }) {
  const t = useTranslations('Vmware');
  const tn = useTranslations('Nav');
  const format = useFormatter();
  const { error } = useErrorText();
  const router = useRouter();
  const [confirmName, setConfirmName] = useState('');
  const q = useApiQuery<Detail>(['vmware', 'connection', id], `/admin/vmware/connections/${id}`);
  const discover = useApiAction(() => apiFetch(`/admin/vmware/connections/${id}/discover`, { method: 'POST' }), { invalidate: [['vmware']], success: t('refreshed') });
  const removeConn = useApiAction(() => apiFetch(`/admin/vmware/connections/${id}`, { method: 'DELETE' }), { invalidate: [['vmware', 'connections']], success: t('removed'), onSuccess: () => router.push('/admin/vmware') });
  const gb = (bytes: unknown) => format.number(Number(bytes) / 1024 ** 3, { maximumFractionDigits: 1 }) + ' GiB';

  const d = q.data;
  if (!d) return <p role="status" className="text-sm text-muted">{q.error ? error(q.error) : t('loading')}</p>;
  const c = d.connection;

  return <div className="flex flex-col gap-6">
    <Breadcrumbs>
      <Breadcrumbs.Item href="/admin/vmware">{tn('connections')}</Breadcrumbs.Item>
      <Breadcrumbs.Item>{c.name}</Breadcrumbs.Item>
    </Breadcrumbs>
    <PageHeader title={c.name} description={<>{c.product.fullName}{c.lastDiscoveredAt && <> · <span title={format.dateTime(new Date(c.lastDiscoveredAt), { dateStyle: 'medium', timeStyle: 'short' })}>
      {t('lastDiscovered', { time: format.relativeTime(new Date(Math.min(Date.parse(c.lastDiscoveredAt), Date.now())), new Date()) })}</span></>}</>}
      actions={<Button variant="secondary" isPending={discover.isPending} onPress={() => discover.mutate()}><I name="refresh-cw" size={16}/>{t('refresh')}</Button>}/>

    {c.warnings.map((w) => <Notice key={w} tone="warning">{t(`warning.${w as 'HOST_MANAGED_BY_VCENTER'}`)}</Notice>)}
    {c.writeApi !== 'available' && <Notice tone="warning">{t(`writeApiNote.${c.writeApi as 'restricted'}`)}</Notice>}
    {/* vSphere's API version and customization method: there is nothing to choose on the other platforms. */}
    {(c.kind === 'esxi' || c.kind === 'vcenter') && <CompatSection connection={c}/>}

    <section aria-labelledby="cap-title" className="flex flex-col gap-3">
      <h2 id="cap-title" className="text-lg font-semibold">{t('capacityTitle')}</h2>
      <p className="text-sm text-muted">{t('capacityNote')}</p>
      <div className="grid gap-4 md:grid-cols-3">
        <Stat label={t('cap.cpu')} icon={<I name="cpu" size={18}/>} value={t('cap.cpuValue', { cores: d.capacity.cpuCores, threads: d.capacity.cpuThreads, ghz: format.number(d.capacity.cpuMhz / 1000, { maximumFractionDigits: 1 }) })}/>
        <Stat label={t('cap.memory')} icon={<I name="memory-stick" size={18}/>} value={gb(d.capacity.memoryBytes)}/>
        <Stat label={t('cap.storage')} icon={<I name="database" size={18}/>} value={gb(d.capacity.storageCapacityBytes)}
          tone={freeTone(d.capacity.storageFreeBytes, d.capacity.storageCapacityBytes) === 'danger' ? 'danger' : 'default'}
          hint={<>{t('cap.storageValue', { capacity: gb(d.capacity.storageCapacityBytes), free: gb(d.capacity.storageFreeBytes), provisioned: gb(d.capacity.storageProvisionedBytes) })}
            {d.capacity.storageCapacityBytes > 0 && <> · {t('used', { pct: Math.round((1 - d.capacity.storageFreeBytes / d.capacity.storageCapacityBytes) * 100) })}</>}</>}/>
      </div>
    </section>

    <Section title={t('operationsTitle')}>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(c.operations).map(([op, ok]) => <li key={op} className="flex items-center justify-between gap-2 rounded-lg bg-default/60 px-3 py-2 text-sm">
          {t(`operation.${op as 'inventory'}`)}: <StatusChip tone={ok ? 'success' : 'default'}>{ok ? t('yes') : t('no')}</StatusChip>
        </li>)}
      </ul>
    </Section>

    <Card>
      <Card.Content>
        <Tabs defaultSelectedKey="vms">
          <Tabs.ListContainer>
            <Tabs.List aria-label={t('title')}>
              <Tabs.Tab id="vms">{t('vmsTitle', { count: d.vms.length })}<Tabs.Indicator/></Tabs.Tab>
              <Tabs.Tab id="hosts">{t('hostsTitle')}<Count n={d.hosts.length}/><Tabs.Indicator/></Tabs.Tab>
              <Tabs.Tab id="datastores">{t('datastoresTitle')}<Count n={d.datastores.length}/>
                {d.datastores.some((x) => freeTone(Number(x.free_bytes), Number(x.capacity_bytes)) === 'danger' || !x.accessible) && <I name="triangle-alert" size={14} className="ml-1 text-danger"/>}<Tabs.Indicator/></Tabs.Tab>
              <Tabs.Tab id="networks">{t('networksTitle')}<Count n={d.networks.length}/><Tabs.Indicator/></Tabs.Tab>
              <Tabs.Tab id="compute">{t('computeTitle')}<Count n={d.compute.length}/><Tabs.Indicator/></Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <Tabs.Panel id="vms" className="pt-4">
            <h2 className="sr-only">{t('vmsTitle', { count: d.vms.length })}</h2>
            <VmList c={c} vms={d.vms}/>
          </Tabs.Panel>
          <Tabs.Panel id="hosts" className="pt-4">
            <DataTable label={t('hostsTitle')} rows={d.hosts} rowKey={(h) => String(h.moref)}
              columns={[{ id: 'name', label: t('col.name') }, { id: 'state', label: t('col.state') }, { id: 'cpu', label: 'CPU' }, { id: 'mem', label: t('cap.memory') }, { id: 'ver', label: t('col.version') }, { id: 'act', label: <span className="sr-only">{t('evacuate')}</span> }]}
              cells={(h) => [String(h.name), `${h.connection_state} / ${h.power_state}${h.in_maintenance ? ` · ${t('maintenance')}` : ''}`,
                t('cap.cpuValue', { cores: Number(h.cpu_cores), threads: Number(h.cpu_threads), ghz: format.number(Number(h.cpu_mhz) / 1000, { maximumFractionDigits: 2 }) }), gb(h.memory_bytes), String(h.version ?? '–'), supports(c, 'migrate') ? <Evacuate key="e" connectionId={id} host={String(h.moref)} name={String(h.name)}/> : null]}/>
          </Tabs.Panel>
          <Tabs.Panel id="datastores" className="pt-4">
            <DataTable label={t('datastoresTitle')} rows={d.datastores} rowKey={(x) => String(x.moref)}
              columns={[{ id: 'name', label: t('col.name') }, { id: 'type', label: t('col.type') }, { id: 'cap', label: t('cap.capacity') }, { id: 'free', label: t('cap.free') }, { id: 'unc', label: t('cap.uncommitted') }, { id: 'state', label: t('col.state') }]}
              cells={(x) => [String(x.name), String(x.type), gb(x.capacity_bytes),
                <span key="f" className="flex min-w-32 flex-col gap-1"><span className={freeTone(Number(x.free_bytes), Number(x.capacity_bytes)) === 'danger' ? 'font-medium text-danger' : ''}>{gb(x.free_bytes)}</span>
                  {Number(x.capacity_bytes) > 0 && <UsedBar label={String(x.name)} used={Number(x.capacity_bytes) - Number(x.free_bytes)} total={Number(x.capacity_bytes)}/>}</span>,
                gb(x.uncommitted_bytes),
                x.accessible ? <StatusChip key="s" tone="success">{t('status.ok')}</StatusChip> : <StatusChip key="s" tone="danger">{t('inaccessible')}</StatusChip>]}/>
          </Tabs.Panel>
          <Tabs.Panel id="networks" className="pt-4">
            <DataTable label={t('networksTitle')} rows={d.networks} rowKey={(n) => String(n.moref)} minWidth={480}
              columns={[{ id: 'name', label: t('col.name') }, { id: 'type', label: t('col.type') }, { id: 'vlan', label: 'VLAN' }, { id: 'sw', label: t('col.switch') }]}
              cells={(n) => [String(n.name), t(`networkKind.${n.kind as 'standard'}`), String(n.vlan ?? '–'), String(n.switch ?? '–')]}/>
          </Tabs.Panel>
          <Tabs.Panel id="compute" className="pt-4">
            <DataTable label={t('computeTitle')} rows={d.compute} rowKey={(x) => String(x.moref)} minWidth={420}
              columns={[{ id: 'name', label: t('col.name') }, { id: 'type', label: t('col.type') }, { id: 'hosts', label: t('col.hosts') }]}
              cells={(x) => [String(x.name), t(`computeKind.${x.kind as 'cluster'}`), String(x.hosts)]}/>
          </Tabs.Panel>
        </Tabs>
      </Card.Content>
    </Card>

    {/* Removing only forgets the connection here; the ESXi/vCenter and its VMs are not touched. */}
    <Section title={t('remove.title')} description={t('remove.explain')} className="border border-danger/30">
      <div className="flex flex-wrap items-end gap-3">
        <TextInput transient className="min-w-64 flex-1" label={t('remove.confirm', { name: c.name })} value={confirmName} onChange={setConfirmName} autoComplete="off"/>
        <Button variant="danger" isDisabled={confirmName !== c.name} isPending={removeConn.isPending} onPress={() => removeConn.mutate()}>{t('remove.button')}</Button>
      </div>
    </Section>
  </div>;
}

// Under 10% free is critical, under 20% a warning.
const freeTone = (free: number, total: number) => (!total ? 'default' : free / total < 0.1 ? 'danger' : free / total < 0.2 ? 'warning' : 'success');

function UsedBar({ label, used, total }: { label: string; used: number; total: number }) {
  const t = useTranslations('Vmware');
  const pct = Math.round((used / total) * 100);
  const tone = freeTone(total - used, total);
  return <span className="mt-1 flex items-center gap-2">
    <ProgressBar aria-label={t('usedOf', { name: label, pct })} value={Math.min(100, pct)} size="sm" className="flex-1" color={tone === 'default' ? 'success' : tone}>
      <ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>
    <span className="shrink-0 text-xs tabular-nums text-muted">{t('used', { pct })}</span>
  </span>;
}

// The VMs of this endpoint: find by name or OS, narrow by power state, export what is shown.
function VmList({ c, vms }: { c: Connection; vms: Row[] }) {
  const t = useTranslations('Vmware');
  const format = useFormatter();
  const [find, setFind] = useState('');
  const [power, setPower] = useState<'all' | 'on' | 'off' | 'template'>('all');
  const q = fold(find.trim());
  const shown = vms.filter((v) => (!q || fold(`${v.name} ${v.guest ?? ''}`).includes(q))
    && (power === 'all' || (power === 'template' ? !!v.template : !v.template && (power === 'on') === (v.power_state === 'poweredOn'))));
  const count = { all: vms.length, on: vms.filter((v) => !v.template && v.power_state === 'poweredOn').length, off: vms.filter((v) => !v.template && v.power_state !== 'poweredOn').length, template: vms.filter((v) => v.template).length };
  return <div className="flex flex-col gap-3">
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      <SearchField aria-label={t('findVm')} value={find} onChange={setFind} className="w-full sm:w-72">
        <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('findVm')}/><SearchField.ClearButton/></SearchField.Group>
      </SearchField>
      <div role="radiogroup" aria-label={t('col.power')} className="flex flex-wrap gap-1">
        {(['all', 'on', 'off', 'template'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={power === k} onClick={() => setPower(k)}
          className={`inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${power === k ? 'bg-accent text-accent-foreground' : 'bg-default text-muted hover:text-foreground'}`}>
          {t(`vmFilter.${k}`)}<span className="tabular-nums opacity-70">{count[k]}</span></button>)}
      </div>
      {shown.length > 0 && <Button size="sm" variant="ghost" className="sm:ml-auto" onPress={() => downloadCsv(`vms-${c.name}`, ['name', 'power', 'vcpu', 'memory_gb', 'guest', 'template', 'moref'],
        shown.map((v) => [v.name, v.power_state, v.cpu, Number(v.memory_mb) / 1024, v.guest ?? '', v.template ? 'yes' : '', v.moref]))}><I name="download" size={14}/>{t('export')}</Button>}
    </div>
    {(q || power !== 'all') && <p role="status" className="text-sm text-muted">{t('vmShown', { n: shown.length, total: vms.length })}</p>}
    <DataTable label={t('vmsTitle', { count: vms.length })} rows={shown} rowKey={(v) => String(v.moref)} empty={q || power !== 'all' ? t('noVmMatch') : '–'}
      columns={[{ id: 'name', label: t('col.name') }, { id: 'power', label: t('col.power') }, { id: 'cpu', label: 'vCPU' }, { id: 'ram', label: 'RAM' }, { id: 'guest', label: t('col.guest') }, { id: 'act', label: <span className="sr-only">{t('console')}</span> }]}
      cells={(v) => [<span key="n">{String(v.name)}{v.template ? <> <StatusChip tone="accent">{t('template')}</StatusChip></> : null}</span>,
        <StatusChip key="p" tone={v.power_state === 'poweredOn' ? 'success' : 'default'}>{t(`powerState.${(['poweredOn', 'poweredOff', 'suspended'].includes(String(v.power_state)) ? v.power_state : 'other') as 'other'}`)}</StatusChip>, String(v.cpu),
        `${format.number(Number(v.memory_mb) / 1024, { maximumFractionDigits: 1 })} GiB`, String(v.guest ?? '–'),
        v.power_state === 'poweredOn' && !v.template && c.operations.console
          ? <ButtonLink key="c" size="sm" variant="secondary" href={`/admin/vmware/console?c=${c.id}&vm=${encodeURIComponent(String(v.moref))}`}><I name="square-terminal" size={14}/>{t('console')}</ButtonLink> : null]}/>
  </div>;
}

// What this endpoint's vSphere version allows, and the admin's override (pin an older API, choose the
// customization method). Saving re-discovers with the new settings, so a wrong choice is refused at once.
function CompatSection({ connection: c }: { connection: Connection }) {
  const t = useTranslations('Vmware');
  const [v, setV] = useState({ apiVersion: c.apiVersion ?? '', customization: c.customization ?? 'auto' });
  const save = useApiAction(() => apiFetch(`/admin/vmware/connections/${c.id}/compat`, { method: 'POST', body: v }), { invalidate: [['vmware']], success: t('compat.saved') });
  const k = c.compat;
  const effective = v.customization === 'auto' ? k?.customization ?? 'cloudinit' : v.customization;
  return <Section title={t('compat.title')} description={t('compat.intro')}>
    <div className="flex flex-col gap-4">
      {k && <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg bg-default/50 px-3 py-2"><dt className="text-xs text-muted">{t('compat.detected')}</dt><dd className="font-medium">{versionLabel(k.apiVersion)} <span className="text-xs text-muted">(API {k.apiVersion})</span></dd></div>
        <div className="rounded-lg bg-default/50 px-3 py-2"><dt className="text-xs text-muted">{t('compat.support')}</dt>
          <dd><StatusChip tone={k.support === 'supported' ? 'success' : k.support === 'legacy' ? 'danger' : 'warning'}>{t(`compat.supportState.${k.support}`)}</StatusChip></dd></div>
        <div className="rounded-lg bg-default/50 px-3 py-2"><dt className="text-xs text-muted">{t('compat.customization')}</dt><dd className="font-medium">{t(`compat.method.${effective}` as 'compat.method.auto')}</dd></div>
        <div className="rounded-lg bg-default/50 px-3 py-2"><dt className="text-xs text-muted">{t('compat.cloning')}</dt><dd>{k.clone ? t('yes') : t('compat.needsVcenter')}</dd></div>
      </dl>}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectInput label={t('compat.version')} value={v.apiVersion} onChange={(x) => setV((s) => ({ ...s, apiVersion: x }))} help={t('compat.versionHelp')}
          options={[{ id: '', label: t('compat.auto') }, ...apiVersions.map((x) => ({ id: x, label: versionLabel(x), description: `API ${x}` }))]}/>
        <SelectInput label={t('compat.customization')} value={v.customization} onChange={(x) => setV((s) => ({ ...s, customization: x as 'auto' }))} help={t('compat.customizationHelp')}
          options={(['auto', 'cloudinit', 'guestinfo'] as const).map((m) => ({ id: m, label: t(`compat.method.${m}`), description: t(`compat.methodHelp.${m}`),
            isDisabled: m === 'cloudinit' && k?.customization !== 'cloudinit' }))}/>
      </div>
      <div className="flex justify-end"><Button variant="secondary" isPending={save.isPending} onPress={() => save.mutate()}><I name="check" size={16}/>{t('compat.save')}</Button></div>
    </div>
  </Section>;
}
