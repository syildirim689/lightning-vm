"use client";
// Locations in the catalog: where servers run (city, country, datacenter, coordinates, status, test endpoints),
// and which location each pool belongs to.
import { Button, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../../components/icon';
import { ConfirmButton, DataTable, FieldGroup, NumberInput, SelectInput, StatusChip, TextInput, undoToast } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { flag } from '../../../../lib/flag';
import { useApiAction, useApiQuery } from '../../../../lib/query';

export { flag };

export type Location = { id: string; name: string; city: string; countryCode: string; datacenter: string; description: string; latitude: number | null; longitude: number | null;
  status: 'active' | 'maintenance' | 'hidden'; pingUrl: string; lookingGlassUrl: string; testIp: string | null; sort: number; pools?: number; servers?: number };
const key = ['catalog', 'locations'];

export const statusTone = { active: 'success', maintenance: 'warning', hidden: 'default' } as const;

export function useLocations() {
  return useApiQuery<{ locations: Location[] }>(key, '/admin/locations').data?.locations ?? [];
}

export function Locations() {
  const t = useTranslations('Catalog.locations');
  const rows = useLocations();
  const [editing, setEditing] = useState<Location | 'new' | null>(null);
  const remove = useApiAction((id: string) => apiFetch(`/admin/locations/${id}`, { method: 'DELETE' }), { invalidate: [key], success: t('removed') });
  return <>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-3xl text-sm text-muted">{t('explain')}</p>
      <Button onPress={() => setEditing('new')}><I name="map-pin-plus" size={16}/>{t('new')}</Button>
    </div>
    <DataTable label={t('title')} rows={rows} rowKey={(l) => l.id} empty={t('empty')} minWidth={760}
      columns={[{ id: 'name', label: t('name') }, { id: 'place', label: t('place') }, { id: 'status', label: t('status') }, { id: 'pools', label: t('pools') },
        { id: 'servers', label: t('servers') }, { id: 'act', label: <span className="sr-only">{t('actions')}</span> }]}
      cells={(l) => [
        <span key="n" className="flex items-center gap-2"><span aria-hidden className="text-lg">{flag(l.countryCode)}</span><span className="font-medium">{l.name}</span></span>,
        <span key="p" className="flex flex-col text-sm"><span>{[l.city, l.countryCode].filter(Boolean).join(', ') || '–'}</span>{l.datacenter && <span className="text-xs text-muted">{l.datacenter}</span>}</span>,
        <StatusChip key="s" tone={statusTone[l.status]}>{t(`statuses.${l.status}`)}</StatusChip>,
        l.pools ?? 0, l.servers ?? 0,
        <span key="a" className="flex gap-1">
          <Button size="sm" variant="ghost" onPress={() => setEditing(l)}><I name="pencil" size={14}/>{t('edit')}</Button>
          <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={t('remove')} title={`${t('remove')}: ${l.name}`} body={t('removeConfirm')}
            confirmLabel={t('remove')} cancelLabel={t('cancel')} isDisabled={(l.pools ?? 0) > 0} onConfirm={() => remove.mutateAsync(l.id).then(() => undefined)}/>
        </span>]}/>
    <Modal.Backdrop isOpen={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog className="sm:max-w-3xl">
          <Modal.CloseTrigger/>
          <Modal.Header><Modal.Heading>{editing === 'new' ? t('new') : t('editTitle')}</Modal.Heading></Modal.Header>
          <Modal.Body>{editing && <LocationForm location={editing === 'new' ? null : editing} onDone={() => setEditing(null)}/>}</Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </>;
}

function LocationForm({ location, onDone }: { location: Location | null; onDone: () => void }) {
  const t = useTranslations('Catalog.locations');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const [v, setV] = useState({ name: location?.name ?? '', city: location?.city ?? '', countryCode: location?.countryCode ?? '', datacenter: location?.datacenter ?? '',
    description: location?.description ?? '', latitude: location?.latitude ?? undefined as number | undefined, longitude: location?.longitude ?? undefined as number | undefined,
    status: location?.status ?? 'active', pingUrl: location?.pingUrl ?? '', lookingGlassUrl: location?.lookingGlassUrl ?? '', testIp: location?.testIp ?? '', sort: location?.sort ?? 0 });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K) => (x: (typeof v)[K]) => { setV((s) => ({ ...s, [k]: x })); setFields((f) => ({ ...f, [k]: '' })); };
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFields({});
    try {
      await apiFetch(location ? `/admin/locations/${location.id}` : '/admin/locations', { method: location ? 'PUT' : 'POST',
        body: { ...v, latitude: v.latitude ?? null, longitude: v.longitude ?? null } });
      await client.invalidateQueries({ queryKey: ['catalog'] }); toast.success(t('saved')); onDone();
    } catch (err) { setFields((err as ApiError).fields ?? {}); toast.danger(error(err)); } finally { setBusy(false); }
  }
  return <form className="flex flex-col gap-4" noValidate onSubmit={save}>
    <FieldGroup title={t('identity')}>
      <TextInput label={t('name')} value={v.name} onChange={set('name')} error={field(fields.name)} isRequired placeholder="Istanbul-1"/>
      <SelectInput label={t('status')} value={v.status} onChange={(x) => set('status')(x as Location['status'])} help={t(`statusHelp.${v.status}`)}
        options={(['active', 'maintenance', 'hidden'] as const).map((s) => ({ id: s, label: t(`statuses.${s}`) }))}/>
      <div className="sm:col-span-2"><TextInput label={t('description')} value={v.description} onChange={set('description')} error={field(fields.description)} help={t('descriptionHelp')}/></div>
    </FieldGroup>
    <FieldGroup title={t('where')} description={t('whereHelp')} cols={3}>
      <TextInput label={t('city')} value={v.city} onChange={set('city')} error={field(fields.city)} placeholder="İstanbul"/>
      <TextInput label={t('country')} value={v.countryCode} onChange={(x) => set('countryCode')(x.toUpperCase().slice(0, 2))} error={field(fields.countryCode)}
        help={v.countryCode.length === 2 ? `${flag(v.countryCode)} ${v.countryCode}` : t('countryHelp')} placeholder="TR" maxLength={2}/>
      <TextInput label={t('datacenter')} value={v.datacenter} onChange={set('datacenter')} error={field(fields.datacenter)} placeholder="Equinix IL2"/>
      <NumberInput label={t('latitude')} value={v.latitude} onChange={set('latitude')} minValue={-90} maxValue={90} step={0.0001} error={field(fields.latitude)} formatOptions={{ maximumFractionDigits: 5 }}/>
      <NumberInput label={t('longitude')} value={v.longitude} onChange={set('longitude')} minValue={-180} maxValue={180} step={0.0001} error={field(fields.longitude)} formatOptions={{ maximumFractionDigits: 5 }}/>
      <NumberInput label={t('sort')} value={v.sort} onChange={(x) => set('sort')(x ?? 0)} minValue={-1000} maxValue={1000} help={t('sortHelp')}/>
    </FieldGroup>
    <FieldGroup title={t('testing')} description={t('testingHelp')}>
      <TextInput label={t('pingUrl')} value={v.pingUrl} onChange={set('pingUrl')} error={field(fields.pingUrl)} help={t('pingUrlHelp')} placeholder="https://speedtest.example.com/ping" spellCheck={false}/>
      <TextInput label={t('lookingGlass')} value={v.lookingGlassUrl} onChange={set('lookingGlassUrl')} error={field(fields.lookingGlassUrl)} placeholder="https://lg.example.com" spellCheck={false}/>
      <TextInput label={t('testIp')} value={v.testIp ?? ''} onChange={set('testIp')} error={field(fields.testIp)} help={t('testIpHelp')} placeholder="203.0.113.10" spellCheck={false}/>
    </FieldGroup>
    <div className="sticky bottom-0 -mx-1 flex justify-end gap-2 border-t border-separator bg-overlay px-1 py-3">
      <Button variant="tertiary" onPress={onDone}>{t('cancel')}</Button>
      <Button type="submit" isPending={busy}><I name="check" size={16}/>{t('save')}</Button>
    </div>
  </form>;
}

// The location of a pool, changed in place on the pool card.
export function PoolLocation({ poolId, locationId }: { poolId: string; locationId: string | null }) {
  const t = useTranslations('Catalog.locations');
  const locations = useLocations();
  const tc = useTranslations('Catalog');
  // Saved on change; the toast offers to put the previous location back.
  const assign = useApiAction((v: { to: string; from?: string }) => apiFetch(`/admin/pools/${poolId}/location`, { method: 'PUT', body: { locationId: v.to || null } }),
    { invalidate: [['catalog']], onSuccess: (_r, v) => undoToast(t('assigned'), v.from, tc('undo'), (from) => assign.mutate({ to: from })) });
  return <SelectInput className="w-56" label={t('poolLocation')} value={locationId ?? ''} onChange={(id) => assign.mutate({ to: id, from: locationId ?? '' })} isDisabled={assign.isPending}
    options={[{ id: '', label: t('noLocation') }, ...locations.map((l) => ({ id: l.id, label: `${flag(l.countryCode)} ${l.name}`.trim() }))]}/>;
}
