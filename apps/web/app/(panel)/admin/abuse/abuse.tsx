"use client";
// Abuse monitoring: risky ports open on customer servers and mining suspicions (CPU near full for hours),
// with acknowledgement, a scan on demand, and the settings. The tab, the search and the tile filter are kept in the
// address, so a list can be linked to and Back returns to it as it was. A third tab lists servers whose use left their
// own baseline (the hourly usage check): statistics, kept apart from the findings, with a note when one resembles them.
import { Button, Modal, SearchField, Tabs, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { useEffect, useState } from 'react';
import { I } from '../../../../components/icon';
import { ButtonLink, DataTable, Mono, NumberInput, PageHeader, Section, Stat, StatusChip, SwitchInput, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { downloadCsv } from '../../../../lib/csv';
import { useMe } from '../../../../lib/me';
import { fold } from '../../../../lib/note-line';
import { can } from '../../../../lib/permissions';
import { useApiQuery } from '../../../../lib/query';
import { gigabytes, type Anomaly } from '../../../../components/anomalies';

type Finding = { id: string; kind: 'port' | 'cpu'; address: string | null; port: number | null; detail: { label?: string; avg?: number; hours?: number };
  firstSeen: string; lastSeen: string; resolvedAt: string | null; acknowledgedAt: string | null; acknowledgedBy: string | null; note: string;
  serverId: string; serverName: string; owner: string; location: string };
type Settings = { portScan: boolean; scanMinutes: number; cpu: boolean; cpuThreshold: number; cpuHours: number; notifyCustomer: boolean; ports: { port: number; label: string }[] };
const key = ['admin', 'abuse'];
type Unusual = Anomaly & { resolvedAt: string | null; serverId: string; serverName: string; owner: string; location: string; abuseOpen: number };

// Servers whose CPU or network use left their own baseline, open ones first. "Resembles abuse" is said when the numbers
// look like what this page watches for, and the abuse findings open on the same server are counted next to it.
function UnusualUse({ rows }: { rows: Unusual[] }) {
  const t = useTranslations('Abuse');
  const ta = useTranslations('Anomalies');
  const format = useFormatter();
  const when = (x: string) => format.relativeTime(new Date(x));
  const up = (a: Unusual) => a.direction === 'high';
  return <DataTable label={t('usage')} rows={rows} rowKey={(a) => a.id} empty={t('usageNone')} minWidth={880}
    columns={[{ id: 'k', label: t('finding') }, { id: 's', label: t('server') }, { id: 'f', label: t('firstSeen') }, { id: 'l', label: t('lastSeen') }, { id: 'a', label: t('status') }, { id: 'x', label: <span className="sr-only">{t('actions')}</span> }]}
    cells={(a) => [
      <span key="k" className="flex flex-col"><span className="flex items-center gap-1.5 font-medium"><I name={up(a) ? 'trending-up' : 'trending-down'} size={14} className={up(a) ? 'text-warning' : 'text-muted'}/>{ta(`kind.${a.metric}.${a.direction}` as 'kind.cpu.high')}</span>
        <span className="text-xs text-muted">{a.metric === 'cpu' ? ta('cpuNumbers', { recent: Math.round(a.detail.recent ?? 0), usual: Math.round(a.detail.usual ?? 0), hours: a.detail.baseline ?? 0, days: a.detail.days ?? 0 })
          : ta('networkNumbers', { recent: gigabytes(a.detail.value), usual: gigabytes(a.detail.usual), days: a.detail.baseline ?? 0, out: Math.round((a.detail.outShare ?? 0) * 100) })}</span></span>,
      <span key="s" className="flex flex-col"><span className="font-medium">{a.serverName}</span><span className="text-xs text-muted">{a.owner}{a.location && ` · ${a.location}`}</span></span>,
      when(a.openedAt), a.resolvedAt ? when(a.resolvedAt) : when(a.lastSeen),
      <span key="a" className="flex flex-col items-start gap-1">
        {a.resolvedAt ? <StatusChip tone="success">{t('closed')}</StatusChip> : a.detail.hint ? <StatusChip tone="warning">{t(`hint.${a.detail.hint}`)}</StatusChip> : <StatusChip tone="default">{t('usageOpen')}</StatusChip>}
        {a.abuseOpen > 0 && <span className="text-xs text-danger">{t('usageAbuseOpen', { n: a.abuseOpen })}</span>}
      </span>,
      <ButtonLink key="x" size="sm" variant="ghost" href={`/servers/${a.serverId}`}><I name="external-link" size={13}/>{t('openServer')}</ButtonLink>]}/>;
}

function AbuseSettings({ initial }: { initial: Settings }) {
  const t = useTranslations('Abuse');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const [v, setV] = useState(initial);
  const [ports, setPorts] = useState(initial.ports.map((p) => `${p.port} ${p.label}`.trim()).join('\n'));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setV(initial); }, [initial]);
  async function save() {
    setBusy(true); setFields({});
    const list = ports.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [p, ...rest] = l.split(/\s+/); return { port: Number(p), label: rest.join(' ') }; });
    try { await apiFetch('/admin/settings/abuse', { method: 'PUT', body: { ...v, ports: list } }); toast.success(t('saved')); client.invalidateQueries({ queryKey: key }); }
    catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Section title={t('settings')} description={t('settingsHelp')}>
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-3">
        <SwitchInput label={t('portScan')} isSelected={v.portScan} onChange={(x) => setV({ ...v, portScan: x })}/>
        <NumberInput label={t('scanMinutes')} value={v.scanMinutes} onChange={(x) => setV({ ...v, scanMinutes: x ?? 30 })} minValue={5} maxValue={1440} error={field(fields.scanMinutes)}/>
        <TextInput label={t('ports')} multiline value={ports} onChange={setPorts} error={field(fields.ports)} help={t('portsHelp')} spellCheck={false}/>
        <SwitchInput label={t('notifyCustomer')} isSelected={v.notifyCustomer} onChange={(x) => setV({ ...v, notifyCustomer: x })}/>
      </div>
      <div className="flex flex-col gap-3">
        <SwitchInput label={t('cpuCheck')} isSelected={v.cpu} onChange={(x) => setV({ ...v, cpu: x })}/>
        <NumberInput label={t('cpuThreshold')} value={v.cpuThreshold} onChange={(x) => setV({ ...v, cpuThreshold: x ?? 90 })} minValue={50} maxValue={100} error={field(fields.cpuThreshold)}/>
        <NumberInput label={t('cpuHours')} value={v.cpuHours} onChange={(x) => setV({ ...v, cpuHours: x ?? 6 })} minValue={1} maxValue={72} error={field(fields.cpuHours)} help={t('cpuHelp')}/>
      </div>
    </div>
    <div className="mt-3 flex justify-end"><Button isPending={busy} onPress={save}><I name="check" size={16}/>{t('save')}</Button></div>
  </Section>;
}

export default function Abuse() {
  const t = useTranslations('Abuse');
  const format = useFormatter();
  const me = useMe();
  const client = useQueryClient();
  const q = useApiQuery<{ findings: Finding[]; settings: Settings }>(key, '/admin/abuse', { refetchInterval: 30_000 });
  const [tab, setTab] = useQueryState('tab', parseAsStringLiteral(['open', 'resolved', 'usage'] as const).withDefault('open'));
  const unusual = useApiQuery<{ anomalies: Unusual[] }>(['admin', 'anomalies'], '/admin/anomalies', { refetchInterval: 60_000 }).data?.anomalies ?? [];
  const [ack, setAck] = useState<Finding | null>(null);
  const [note, setNote] = useState('');
  const [find, setFind] = useQueryState('q', parseAsString.withDefault('').withOptions({ history: 'replace', throttleMs: 300 }));
  const [only, setOnly] = useQueryState('only', parseAsStringLiteral(['port', 'cpu', 'unack'] as const));
  const [acking, setAcking] = useState(false);
  const { error } = useErrorText();
  const d = q.data;
  const needle = fold(find.trim());
  const hit = (f: Finding) => !needle || fold([f.serverName, f.owner, f.location, f.address, f.port, f.detail.label].join(' ')).includes(needle);
  const kindOk = (f: Finding) => !only || (only === 'unack' ? !f.acknowledgedAt : f.kind === only);
  const list = (d?.findings ?? []).filter((f) => (tab === 'open' ? !f.resolvedAt : !!f.resolvedAt) && hit(f) && kindOk(f));
  const pick = (k: 'port' | 'cpu' | 'unack') => { void setOnly(only === k ? null : k); void setTab(null); };
  const when = (x: string) => format.relativeTime(new Date(x));
  async function scan() {
    try { await apiFetch('/admin/abuse/scan', { method: 'POST' }); toast.success(t('scanning')); setTimeout(() => client.invalidateQueries({ queryKey: key }), 15000); }
    catch { toast.danger(t('scanFailed')); }
  }
  async function acknowledge() {
    if (!ack) return;
    setAcking(true);
    await apiFetch(`/admin/abuse/${ack.id}/acknowledge`, { method: 'PUT', body: { note } }).then(() => { toast.success(t('acknowledged')); client.invalidateQueries({ queryKey: key }); }, (e) => toast.danger(error(e)));
    setAck(null); setNote(''); setAcking(false);
  }
  const open = (d?.findings ?? []).filter((f) => !f.resolvedAt);
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')} actions={<Button variant="secondary" onPress={scan}><I name="radar" size={16}/>{t('scanNow')}</Button>}/>
    {!d ? <p role="status" className="text-sm text-muted">{t('loading')}</p> : <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t('openPorts')} value={open.filter((f) => f.kind === 'port').length} icon={<I name="door-open" size={18}/>} tone={open.some((f) => f.kind === 'port') ? 'warning' : 'default'} pressed={only === 'port'} onPress={() => pick('port')}/>
        <Stat label={t('mining')} value={open.filter((f) => f.kind === 'cpu').length} icon={<I name="pickaxe" size={18}/>} tone={open.some((f) => f.kind === 'cpu') ? 'danger' : 'default'} pressed={only === 'cpu'} onPress={() => pick('cpu')}/>
        <Stat label={t('unacknowledged')} value={open.filter((f) => !f.acknowledgedAt).length} icon={<I name="bell-ring" size={18}/>} pressed={only === 'unack'} onPress={() => pick('unack')}/>
      </div>
      <Tabs selectedKey={tab} onSelectionChange={(k) => void setTab(k === 'resolved' || k === 'usage' ? k : null)}>
        <Tabs.ListContainer><Tabs.List aria-label={t('title')}>
          <Tabs.Tab id="open">{t('open')}<span className="ml-1.5 rounded-full bg-default px-1.5 text-xs tabular-nums">{open.length}</span><Tabs.Indicator/></Tabs.Tab>
          <Tabs.Tab id="resolved">{t('resolved')}<span className="ml-1.5 rounded-full bg-default px-1.5 text-xs tabular-nums">{d.findings.length - open.length}</span><Tabs.Indicator/></Tabs.Tab>
          <Tabs.Tab id="usage">{t('usage')}<span className="ml-1.5 rounded-full bg-default px-1.5 text-xs tabular-nums">{unusual.filter((a) => !a.resolvedAt).length}</span><Tabs.Indicator/></Tabs.Tab>
        </Tabs.List></Tabs.ListContainer>
        {tab !== 'usage' && <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <SearchField aria-label={t('find')} value={find} onChange={(v) => void setFind(v || null)} className="w-full sm:w-80">
            <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('findPlaceholder')}/><SearchField.ClearButton/></SearchField.Group>
          </SearchField>
          {only && <Button size="sm" variant="secondary" onPress={() => void setOnly(null)}><I name="x" size={14}/>{t('clearFilter', { what: t(only === 'port' ? 'openPorts' : only === 'cpu' ? 'mining' : 'unacknowledged') })}</Button>}
          {list.length > 0 && <Button size="sm" variant="ghost" className="sm:ml-auto" onPress={() => downloadCsv('abuse', ['kind', 'finding', 'address', 'server', 'owner', 'location', 'first_seen', 'last_seen', 'resolved', 'acknowledged_by', 'note'],
            list.map((f) => [f.kind, f.kind === 'port' ? f.detail.label ?? '' : `${f.detail.avg ?? 0}% / ${f.detail.hours ?? 0}h`, f.address ? `${f.address}:${f.port ?? ''}` : '', f.serverName, f.owner, f.location, f.firstSeen, f.lastSeen, f.resolvedAt ?? '', f.acknowledgedBy ?? '', f.note]))}>
            <I name="download" size={14}/>{t('export')}</Button>}
        </div>}
        <Tabs.Panel id={tab} className="pt-4">
          {tab === 'usage' ? <><p className="mb-3 text-sm text-muted">{t('usageHelp')}</p><UnusualUse rows={unusual}/></> : <DataTable label={t('title')} rows={list} rowKey={(f) => f.id} empty={needle || only ? t('noMatch') : tab === 'open' ? t('none') : t('noneResolved')} minWidth={880}
            columns={[{ id: 'k', label: t('finding') }, { id: 's', label: t('server') }, { id: 'f', label: t('firstSeen') }, { id: 'l', label: t('lastSeen') }, { id: 'a', label: t('status') }, { id: 'x', label: <span className="sr-only">{t('actions')}</span> }]}
            cells={(f) => [
              f.kind === 'port' ? <span key="k" className="flex flex-col"><span className="flex items-center gap-1.5 font-medium"><I name="door-open" size={14} className="text-warning"/>{f.detail.label || t('port')}</span><Mono>{f.address}:{f.port}</Mono></span>
                : <span key="k" className="flex flex-col"><span className="flex items-center gap-1.5 font-medium"><I name="pickaxe" size={14} className="text-danger"/>{t('miningSuspected')}</span><span className="text-xs text-muted">{t('cpuDetail', { avg: f.detail.avg ?? 0, hours: f.detail.hours ?? 0 })}</span></span>,
              <span key="s" className="flex flex-col"><span className="font-medium">{f.serverName}</span><span className="text-xs text-muted">{f.owner}{f.location && ` · ${f.location}`}</span></span>,
              when(f.firstSeen), f.resolvedAt ? when(f.resolvedAt) : when(f.lastSeen),
              f.acknowledgedAt ? <span key="a" className="flex flex-col"><StatusChip tone="default">{t('ackBy', { who: f.acknowledgedBy ?? '–' })}</StatusChip>{f.note && <span className="text-xs text-muted">{f.note}</span>}</span>
                : f.resolvedAt ? <StatusChip key="a" tone="success">{t('closed')}</StatusChip> : <StatusChip key="a" tone="warning">{t('new')}</StatusChip>,
              <span key="x" className="flex gap-1">
                <ButtonLink size="sm" variant="ghost" href={`/servers/${f.serverId}`}><I name="external-link" size={13}/>{t('openServer')}</ButtonLink>
                {!f.resolvedAt && !f.acknowledgedAt && can(me?.permissions, 'servers.manage_all') && <Button size="sm" variant="ghost" onPress={() => setAck(f)}><I name="check" size={13}/>{t('acknowledge')}</Button>}
              </span>]}/>}
        </Tabs.Panel>
      </Tabs>
      <p className="text-xs text-muted">{t('disclaimer')}</p>
      {can(me?.permissions, 'settings.manage') && <AbuseSettings initial={d.settings}/>}
    </div>}
    <Modal.Backdrop isOpen={!!ack} onOpenChange={(o) => !o && setAck(null)}>
      <Modal.Container size="md"><Modal.Dialog>
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading>{t('acknowledge')}</Modal.Heading></Modal.Header>
        <Modal.Body className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t('ackHelp')}</p>
          <TextInput maxLength={500} label={t('note')} value={note} onChange={setNote} multiline/>
          <div className="flex justify-end"><Button isPending={acking} onPress={acknowledge}><I name="check" size={16}/>{t('acknowledge')}</Button></div>
        </Modal.Body>
      </Modal.Dialog></Modal.Container>
    </Modal.Backdrop>
  </>;
}
