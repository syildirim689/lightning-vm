"use client";
// Energy: current power, kWh over time, cost and carbon (with the facility's PUE), per host, location and
// server. Hosts without a power counter are estimated from a profile the admin can set per host.
import { Button, Card, Modal, Tabs, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Area, Bar, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { I } from '../../../../components/icon';
import { DataTable, NumberInput, PageHeader, Section, Stat, StatusChip, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { flag } from '../../../../lib/flag';
import { useMe } from '../../../../lib/me';
import { can } from '../../../../lib/permissions';
import { useApiQuery } from '../../../../lib/query';

type Settings = { pricePerKwh: string; currency: string; pue: number; co2GramsPerKwh: number };
type Host = { connectionId: string; connection: string; moref: string; name: string; kwh: number; watts: number; source: 'measured' | 'estimated'; cpuUtil: number | null; idleWatts: number | null; maxWatts: number | null };
type Report = { settings: Settings; now: { watts: number; facilityWatts: number; hosts: number; measured: number };
  energy: { todayKwh: number; monthKwh: number; rangeKwh: number; facilityMonthKwh: number; costToday: string; costMonth: string; costRange: string; co2MonthKg: number; co2RangeKg: number };
  series: { t: string; kwh: number; watts: number }[]; hosts: Host[]; locations: { id: string; name: string; countryCode: string; kwh: number }[];
  servers: { id: string; name: string; owner: string; location: string; kwh: number; watts: number }[] };
const tooltip = { background: 'var(--overlay)', border: '1px solid var(--border)', borderRadius: 12, fontSize: 12 };

function Profile({ host, onDone }: { host: Host; onDone: () => void }) {
  const t = useTranslations('Energy');
  const { error, field } = useErrorText();
  const [idle, setIdle] = useState<number | undefined>(host.idleWatts ?? 120);
  const [max, setMax] = useState<number | undefined>(host.maxWatts ?? 400);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function save(reset = false) {
    setBusy(true); setFields({});
    try {
      await apiFetch('/admin/power/profiles', { method: 'PUT', body: { connectionId: host.connectionId, hostMoref: host.moref, idleWatts: reset ? null : idle, maxWatts: reset ? null : max } });
      toast.success(t('profileSaved')); onDone();
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <div className="flex flex-col gap-4">
    <p className="text-sm text-muted">{t('profileHelp')}</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <NumberInput label={t('idleWatts')} value={idle} onChange={setIdle} minValue={0} maxValue={20000} error={field(fields.idleWatts)}/>
      <NumberInput label={t('maxWatts')} value={max} onChange={setMax} minValue={1} maxValue={20000} error={field(fields.maxWatts)}/>
    </div>
    <div className="flex justify-between gap-2">
      <Button variant="ghost" isDisabled={busy || host.idleWatts === null} onPress={() => save(true)}><I name="rotate-ccw" size={14}/>{t('defaultProfile')}</Button>
      <Button isPending={busy} onPress={() => save()}><I name="check" size={16}/>{t('save')}</Button>
    </div>
  </div>;
}

function EnergySettings({ s, onSaved }: { s: Settings; onSaved: () => void }) {
  const t = useTranslations('Energy');
  const { error, field } = useErrorText();
  const [v, setV] = useState({ ...s });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setFields({});
    try { await apiFetch('/admin/settings/energy', { method: 'PUT', body: v }); toast.success(t('settingsSaved')); onSaved(); }
    catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Section title={t('settings')} description={t('settingsHelp')}>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <TextInput label={t('price')} value={v.pricePerKwh} onChange={(x) => setV({ ...v, pricePerKwh: x })} error={field(fields.pricePerKwh)} help={t('priceHelp')}/>
      <TextInput label={t('currency')} value={v.currency} onChange={(x) => setV({ ...v, currency: x.toUpperCase().slice(0, 3) })} error={field(fields.currency)} placeholder="TRY"/>
      <NumberInput label="PUE" value={v.pue} onChange={(x) => setV({ ...v, pue: x ?? 1.5 })} minValue={1} maxValue={3} step={0.05} error={field(fields.pue)} help={t('pueHelp')}
        formatOptions={{ maximumFractionDigits: 2 }}/>
      <NumberInput label={t('co2')} value={v.co2GramsPerKwh} onChange={(x) => setV({ ...v, co2GramsPerKwh: x ?? 0 })} minValue={0} maxValue={2000} error={field(fields.co2GramsPerKwh)} help={t('co2Help')}/>
    </div>
    <div className="mt-3 flex justify-end"><Button isPending={busy} onPress={save}><I name="check" size={16}/>{t('save')}</Button></div>
  </Section>;
}

export default function Energy() {
  const t = useTranslations('Energy');
  const format = useFormatter();
  const me = useMe();
  const client = useQueryClient();
  const [range, setRange] = useState('1d');
  const [editing, setEditing] = useState<Host | null>(null);
  const q = useApiQuery<Report>(['power', range], `/admin/power?range=${range}`, { refetchInterval: 60_000 });
  const d = q.data;
  const refresh = () => client.invalidateQueries({ queryKey: ['power'] });
  const n = (x: number, digits = 1) => format.number(x, { maximumFractionDigits: digits });
  const money = (x: string) => d ? format.number(Number(x), { style: 'currency', currency: d.settings.currency }) : '–';
  async function measure() {
    try { await apiFetch('/admin/power/sample', { method: 'POST' }); toast.success(t('measuring')); setTimeout(refresh, 8000); } catch { /* shown by the next refresh */ }
  }
  const chart = (d?.series ?? []).map((p) => ({ ...p, label: format.dateTime(new Date(p.t), range === '30d' ? { dateStyle: 'short' } : { timeStyle: 'short', ...(range === '7d' && { dateStyle: 'short' }) }) }));
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')}
      actions={<Button variant="secondary" onPress={measure}><I name="zap" size={16}/>{t('measureNow')}</Button>}/>
    {!d ? <p role="status" className="text-sm text-muted">{t('loading')}</p> : <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={t('now')} value={`${n(d.now.watts / 1000, 2)} kW`} hint={t('facility', { kw: n(d.now.facilityWatts / 1000, 2), pue: d.settings.pue })} icon={<I name="zap" size={18}/>} tone="accent"/>
        <Stat label={t('today')} value={`${n(d.energy.todayKwh)} kWh`} hint={money(d.energy.costToday)} icon={<I name="calendar-clock" size={18}/>}/>
        <Stat label={t('month')} value={`${n(d.energy.monthKwh)} kWh`} hint={t('monthHint', { cost: money(d.energy.costMonth), facility: n(d.energy.facilityMonthKwh) })} icon={<I name="calendar" size={18}/>}/>
        <Stat label={t('co2Month')} value={`${n(d.energy.co2MonthKg)} kg`} hint={t('co2Hint', { g: d.settings.co2GramsPerKwh })} icon={<I name="leaf" size={18}/>} tone="success"/>
      </div>
      <p className="text-xs text-muted">{t('measuredOf', { measured: d.now.measured, hosts: d.now.hosts })}</p>

      <Section title={t('history')} actions={<Tabs selectedKey={range} onSelectionChange={(k) => setRange(String(k))}>
        <Tabs.ListContainer><Tabs.List aria-label={t('history')}>{['1d', '7d', '30d'].map((r) => <Tabs.Tab key={r} id={r}>{t(`ranges.${r}` as 'ranges.1d')}<Tabs.Indicator/></Tabs.Tab>)}</Tabs.List></Tabs.ListContainer>
      </Tabs>}>
        {chart.length === 0 ? <p className="text-sm text-muted">{t('noData')}</p> : <Card variant="secondary"><Card.Content className="p-3">
          <div className="h-64" role="img" aria-label={t('chartLabel', { kwh: n(d.energy.rangeKwh), cost: money(d.energy.costRange) })}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs><linearGradient id="g-watts" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity={0.3}/><stop offset="100%" stopColor="var(--accent)" stopOpacity={0}/></linearGradient></defs>
                <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--muted)" minTickGap={24}/>
                <YAxis yAxisId="kwh" tick={{ fontSize: 11 }} stroke="var(--muted)" width={44}/>
                <YAxis yAxisId="w" orientation="right" tick={{ fontSize: 11 }} stroke="var(--muted)" width={52}/>
                <Tooltip contentStyle={tooltip} formatter={(v, name) => name === 'kwh' ? [`${n(Number(v), 2)} kWh`, t('energy')] : [`${n(Number(v), 0)} W`, t('avgPower')]}/>
                <Bar yAxisId="kwh" dataKey="kwh" fill="var(--success)" radius={[4, 4, 0, 0]} isAnimationActive={false}/>
                <Area yAxisId="w" type="monotone" dataKey="watts" stroke="var(--accent)" strokeWidth={2} fill="url(#g-watts)" isAnimationActive={false}/>
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-xs text-muted">{t('rangeTotal', { kwh: n(d.energy.rangeKwh, 2), cost: money(d.energy.costRange), co2: n(d.energy.co2RangeKg) })}</p>
        </Card.Content></Card>}
      </Section>

      <Section title={t('hosts')} description={t('hostsHelp')}>
        <DataTable label={t('hosts')} rows={d.hosts} rowKey={(h) => `${h.connectionId}-${h.moref}`} empty={t('noData')} minWidth={760}
          columns={[{ id: 'n', label: t('host') }, { id: 'w', label: t('nowShort') }, { id: 'src', label: t('source') }, { id: 'cpu', label: 'CPU' }, { id: 'k', label: t('energy') },
            { id: 'p', label: t('profile') }]}
          cells={(h) => [<span key="n" className="flex flex-col"><span className="font-medium">{h.name || h.moref}</span><span className="text-xs text-muted">{h.connection}</span></span>,
            `${n(h.watts, 0)} W`, <StatusChip key="s" tone={h.source === 'measured' ? 'success' : 'warning'}>{t(`sources.${h.source}`)}</StatusChip>,
            h.cpuUtil === null ? '–' : `%${n(h.cpuUtil * 100, 0)}`, `${n(h.kwh, 2)} kWh`,
            <span key="p" className="flex items-center gap-2 text-xs text-muted">{h.idleWatts !== null ? `${h.idleWatts}–${h.maxWatts} W` : t('defaultShort')}
              {can(me?.permissions, 'settings.manage') && <Button size="sm" variant="ghost" onPress={() => setEditing(h)}><I name="pencil" size={13}/>{t('edit')}</Button>}</span>]}/>
      </Section>

      <div className="grid gap-6 xl:grid-cols-2">
        <Section title={t('locations')}>
          <DataTable label={t('locations')} rows={d.locations} rowKey={(l) => l.id} empty={t('noLocations')} minWidth={360}
            columns={[{ id: 'n', label: t('location') }, { id: 'k', label: t('energy') }, { id: 'c', label: t('cost') }]}
            cells={(l) => [`${flag(l.countryCode)} ${l.name}`.trim(), `${n(l.kwh, 2)} kWh`, money(String(l.kwh * d.settings.pue * Number(d.settings.pricePerKwh)))]}/>
        </Section>
        <Section title={t('servers')} description={t('serversHelp')}>
          <DataTable label={t('servers')} rows={d.servers} rowKey={(s) => s.id} empty={t('noData')} minWidth={480}
            columns={[{ id: 'n', label: t('server') }, { id: 'w', label: t('avgPower') }, { id: 'k', label: t('energy') }]}
            cells={(s) => [<span key="n" className="flex flex-col"><span className="font-medium">{s.name}</span><span className="text-xs text-muted">{s.owner}{s.location && ` · ${s.location}`}</span></span>,
              `${n(s.watts, 0)} W`, `${n(s.kwh, 3)} kWh`]}/>
        </Section>
      </div>

      {can(me?.permissions, 'settings.manage') && <EnergySettings s={d.settings} onSaved={refresh}/>}
    </div>}
    <Modal.Backdrop isOpen={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
      <Modal.Container size="md"><Modal.Dialog>
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading>{t('profileTitle', { host: editing?.name ?? '' })}</Modal.Heading></Modal.Header>
        <Modal.Body>{editing && <Profile host={editing} onDone={() => { setEditing(null); refresh(); }}/>}</Modal.Body>
      </Modal.Dialog></Modal.Container>
    </Modal.Backdrop>
  </>;
}
