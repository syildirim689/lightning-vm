"use client";
// IP management in the catalog: extra IPv4 for sale per location, IP pool settings (quarantine, IPv6, DNS,
// excluded addresses) and every address that is not simply free (in use with its PTR, in quarantine, excluded).
import { Button, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../../components/icon';
import { ConfirmButton, DataTable, FieldGroup, FormActions, Mono, NumberInput, SelectInput, StatusChip, TextInput } from '../../../../components/ui';
import { downloadCsv } from '../../../../lib/csv';
import { fold } from '../../../../lib/note-line';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

export type IpPoolRow = { id: string; name: string; poolName: string; cidr: string; gateway: string; rangeStart: string; rangeEnd: string; size: number; dns: string[]; excluded: string[];
  quarantineHours: number; ipv6Prefix: string | null; ipv6Gateway: string | null; used: number; quarantined: number };
type Address = { address: string; ipPoolId: string; state: 'used' | 'quarantine' | 'excluded'; kind: 'primary' | 'extra' | 'ipv6' | null; ptr: string | null;
  serverId: string | null; serverName: string | null; owner: string | null; since: string | null; until: string | null };

// Extra IPv4 a location sells with each server: how many at most, and the monthly price of each.
export function PoolIpOptions({ pool }: { pool: { id: string; extraIpv4Max: number; extraIpv4Price: string; trafficGb?: number | null } }) {
  const t = useTranslations('Catalog.ipm');
  const { error } = useErrorText();
  const client = useQueryClient();
  const [max, setMax] = useState<number | undefined>(pool.extraIpv4Max);
  const [price, setPrice] = useState(pool.extraIpv4Price);
  const [traffic, setTraffic] = useState<number | undefined>(pool.trafficGb ?? undefined);
  const [busy, setBusy] = useState(false);
  const changed = max !== pool.extraIpv4Max || price !== pool.extraIpv4Price || (traffic ?? null) !== (pool.trafficGb ?? null);
  async function save() {
    setBusy(true);
    try { await apiFetch(`/admin/pools/${pool.id}/ip-options`, { method: 'PUT', body: { extraIpv4Max: max ?? 0, extraIpv4Price: price || '0', trafficGb: traffic ?? null } }); toast.success(t('saved')); client.invalidateQueries({ queryKey: ['catalog'] }); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border p-3">
    <NumberInput className="w-40" label={t('extraMax')} value={max} onChange={setMax} minValue={0} maxValue={32} help={t('extraMaxHelp')}/>
    <TextInput className="w-40" label={t('extraPrice')} value={price} onChange={setPrice} help={t('extraPriceHelp')}/>
    <NumberInput className="w-48" label={t('traffic')} value={traffic} onChange={setTraffic} minValue={1} step={100} help={t('trafficHelp')}/>
    <Button size="sm" variant="secondary" isPending={busy} isDisabled={!changed} onPress={save}><I name="check" size={14}/>{t('save')}</Button>
  </div>;
}

export function IpPoolEdit({ ipPool }: { ipPool: IpPoolRow }) {
  const t = useTranslations('Catalog.ipm');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ quarantineHours: ipPool.quarantineHours, ipv6Prefix: ipPool.ipv6Prefix ?? '', ipv6Gateway: ipPool.ipv6Gateway ?? '',
    dns: ipPool.dns.join(', '), excluded: ipPool.excluded.join(', ') });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const list = (s: string) => s.split(/[\s,]+/).filter(Boolean);
  async function save() {
    setBusy(true); setFields({});
    try {
      await apiFetch(`/admin/ip-pools/${ipPool.id}`, { method: 'PUT', body: { ...v, dns: list(v.dns), excluded: list(v.excluded) } });
      toast.success(t('saved')); client.invalidateQueries({ queryKey: ['catalog', 'ip'] }); client.invalidateQueries({ queryKey: ['catalog', 'addresses'] }); setOpen(false);
    } catch (e) { setFields((e as { fields?: Record<string, string> }).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <>
    <Button size="sm" variant="ghost" onPress={() => setOpen(true)}><I name="pencil" size={14}/>{t('edit')}</Button>
    <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog className="sm:max-w-2xl">
          <Modal.CloseTrigger/>
          <Modal.Header><Modal.Heading>{t('editTitle', { name: ipPool.name })}</Modal.Heading></Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            <FieldGroup title={t('quarantine')} description={t('quarantineHelp')} cols={1}>
              <NumberInput label={t('quarantineHours')} value={v.quarantineHours} onChange={(x) => setV({ ...v, quarantineHours: x ?? 0 })} minValue={0} maxValue={8760} error={field(fields.quarantineHours)}/>
            </FieldGroup>
            <FieldGroup title="IPv6" description={t('ipv6Help')}>
              <TextInput label={t('ipv6Prefix')} value={v.ipv6Prefix} onChange={(x) => setV({ ...v, ipv6Prefix: x })} placeholder="2001:db8:40::/64" error={field(fields.ipv6Prefix)} spellCheck={false}/>
              <TextInput label={t('ipv6Gateway')} value={v.ipv6Gateway} onChange={(x) => setV({ ...v, ipv6Gateway: x })} placeholder="2001:db8:40::1" error={field(fields.ipv6Gateway)} spellCheck={false}/>
            </FieldGroup>
            <FieldGroup title={t('other')}>
              <TextInput label={t('dns')} value={v.dns} onChange={(x) => setV({ ...v, dns: x })} help={t('listHelp')} spellCheck={false}/>
              <TextInput label={t('excluded')} value={v.excluded} onChange={(x) => setV({ ...v, excluded: x })} help={t('excludedHelp')} spellCheck={false}/>
            </FieldGroup>
            <FormActions><Button variant="tertiary" onPress={() => setOpen(false)}>{t('cancel')}</Button><Button isPending={busy} onPress={save}>{t('save')}</Button></FormActions>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </>;
}

const tone = { used: 'accent', quarantine: 'warning', excluded: 'default' } as const;
export function IpAddresses({ ipPools }: { ipPools: IpPoolRow[] }) {
  const t = useTranslations('Catalog.ipm');
  const format = useFormatter();
  const { error } = useErrorText();
  const client = useQueryClient();
  const [poolId, setPoolId] = useState('');
  const [state, setState] = useState('');
  const [search, setSearch] = useState('');
  const q = useApiQuery<{ addresses: Address[] }>(['catalog', 'addresses', poolId], `/admin/ip-addresses${poolId ? `?ipPoolId=${poolId}` : ''}`);
  const all = q.data?.addresses ?? [];
  const needle = fold(search.trim());
  const rows = all.filter((a) => (!state || a.state === state) && (!needle || fold(`${a.address} ${a.serverName ?? ''} ${a.owner ?? ''} ${a.ptr ?? ''}`).includes(needle)));
  const count = (s: string) => all.filter((a) => a.state === s).length;
  async function release(address: string) {
    try { await apiFetch(`/admin/ip-quarantine/${encodeURIComponent(address)}`, { method: 'DELETE' }); toast.success(t('released')); client.invalidateQueries({ queryKey: ['catalog'] }); }
    catch (e) { toast.danger(error(e)); }
  }
  return <section className="flex flex-col gap-3">
    <h3 className="font-semibold">{t('addresses')}</h3>
    <p className="text-sm text-muted">{t('addressesHelp')}</p>
    <div className="flex flex-wrap items-end gap-3">
      <TextInput className="min-w-52 flex-1" label={t('search')} value={search} onChange={setSearch} placeholder="203.0.113.10, web-1, mail.example.com"/>
      <SelectInput className="w-52" label={t('pool')} value={poolId} onChange={setPoolId} options={[{ id: '', label: t('all') }, ...ipPools.map((p) => ({ id: p.id, label: p.name }))]}/>
      <SelectInput className="w-44" label={t('state')} value={state} onChange={setState} options={[{ id: '', label: `${t('all')} (${all.length})` }, ...(['used', 'quarantine', 'excluded'] as const).map((s) => ({ id: s, label: `${t(`states.${s}`)} (${count(s)})` }))]}/>
      {rows.length > 0 && <Button variant="ghost" className="min-h-10" onPress={() => downloadCsv('ip-addresses', ['address', 'state', 'kind', 'server', 'owner', 'ptr', 'since', 'until'],
        rows.map((a) => [a.address, a.state, a.kind ?? '', a.serverName ?? '', a.owner ?? '', a.ptr ?? '', a.since ?? '', a.until ?? '']))}><I name="download" size={15}/>{t('export')}</Button>}
    </div>
    {(!!needle || !!state) && <p role="status" className="text-sm text-muted">{t('shown', { n: rows.length, total: all.length })}</p>}
    <DataTable label={t('addresses')} rows={rows} rowKey={(a) => `${a.state}-${a.address}`} empty={t('none')} minWidth={820}
      columns={[{ id: 'ip', label: 'IP' }, { id: 'state', label: t('state') }, { id: 'server', label: t('server') }, { id: 'ptr', label: 'PTR' }, { id: 'when', label: t('when') }, { id: 'act', label: '' }]}
      cells={(a) => [<Mono key="ip">{a.address}</Mono>,
        <span key="s" className="flex flex-wrap gap-1"><StatusChip tone={tone[a.state]}>{t(`states.${a.state}`)}</StatusChip>{a.kind && a.kind !== 'primary' && <StatusChip tone="default">{t(`kinds.${a.kind}`)}</StatusChip>}</span>,
        a.serverId ? <span key="sv" className="flex flex-col"><a className="font-medium hover:underline" href={`/servers/${a.serverId}`}>{a.serverName}</a><span className="text-xs text-muted">{a.owner}</span></span> : (a.serverName ?? '–'),
        a.ptr ? <Mono key="p">{a.ptr}</Mono> : '–',
        a.state === 'quarantine' && a.until ? t('until', { time: format.dateTime(new Date(a.until), { dateStyle: 'medium', timeStyle: 'short' }) })
          : a.since ? format.dateTime(new Date(a.since), { dateStyle: 'medium' }) : '–',
        a.state === 'quarantine' ? <ConfirmButton key="r" size="sm" variant="secondary" icon={<I name="unlock" size={14}/>} label={t('release')} title={t('releaseTitle', { address: a.address })}
          body={t('releaseBody')} confirmLabel={t('release')} cancelLabel={t('cancel')} onConfirm={() => release(a.address)}/> : null]}/>
  </section>;
}
