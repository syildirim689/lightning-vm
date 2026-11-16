"use client";
// Server settings: what customers may do on their own servers (the API enforces it; staff always may), and the
// hardware options every new VM gets.
import { Button, Card, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../../components/icon';
import { FormActions, FormSection, Notice, NumberInput, SelectInput, SwitchInput, Loading } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Doc = { customer: { power: boolean; console: boolean; iso: boolean; rootPassword: boolean; delete: boolean; snapshots: boolean; resize: boolean; reinstall: boolean; backups: boolean };
  backups?: { maxPerServer: number }; hardware: { cpuHotAdd: boolean; memoryHotAdd: boolean; nestedHv: boolean };
  traffic?: { overLimit: 'notify' | 'throttle'; throttleMbps: number }; deleteGraceHours?: number; guestUpdates?: boolean };

export default function ServerSettings({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.servers');
  const { error } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<Doc>(['settings', 'servers'], '/admin/settings/servers').data;
  const [v, setV] = useState<Doc | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q && !v) setV(q); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return <Loading of={['settings', 'servers']}/>;
  async function save() {
    setBusy(true);
    // The saved document goes back into the cache: a later visit to this tab starts from it, not from the old one.
    try { const r = await apiFetch<Doc>('/admin/settings/servers', { method: 'PUT', body: v }); client.setQueryData(['settings', 'servers'], r); setV(r); toast.success(t('saved')); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  const icons = { power: 'power', console: 'square-terminal', iso: 'disc-3', rootPassword: 'key-round', delete: 'trash-2', snapshots: 'camera', resize: 'gauge', reinstall: 'refresh-cw', backups: 'archive' } as const;
  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('customer')} description={t('customerHelp')} icon={<I name="user-cog" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {(Object.keys(icons) as (keyof Doc['customer'])[]).map((k) => <div key={k} className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
          <div className="flex items-start gap-2">
            <I name={{ power: 'power', console: 'square-terminal', iso: 'disc-3', rootPassword: 'key-round', delete: 'trash-2', snapshots: 'camera', resize: 'gauge', reinstall: 'refresh-cw', backups: 'archive' }[k]} size={16}/>
            <div><p className="text-sm font-medium">{t(`actions.${k}`)}</p><p className="text-xs text-muted">{t(`actionHelp.${k}`)}</p></div>
          </div>
          <SwitchInput label={<span className="sr-only">{t(`actions.${k}`)}</span>} isSelected={v.customer[k]} isDisabled={readOnly}
            onChange={(x) => setV({ ...v, customer: { ...v.customer, [k]: x } })}/>
        </div>)}
      </div>
      <p className="text-xs text-muted">{t('rolesNote')}</p>
    </FormSection>
    <FormSection title={t('backupsTitle')} description={t('backupsHelp')} icon={<I name="archive" size={16}/>}>
      <NumberInput className="max-w-xs" label={t('maxBackups')} value={v.backups?.maxPerServer ?? 7} minValue={1} maxValue={50} isDisabled={readOnly} onChange={(x) => setV({ ...v, backups: { maxPerServer: x ?? 7 } })}/>
    </FormSection>
    <FormSection title={t('deleteTitle')} description={t('deleteHelp')} icon={<I name="history" size={16}/>}>
      <NumberInput className="max-w-xs" label={t('deleteGraceHours')} value={v.deleteGraceHours ?? 24} minValue={0} maxValue={168} isDisabled={readOnly} onChange={(x) => setV({ ...v, deleteGraceHours: x ?? 0 })}/>
    </FormSection>
    <FormSection title={t('traffic')} description={t('trafficHelp')} icon={<I name="gauge" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectInput label={t('overLimit')} value={v.traffic?.overLimit ?? 'throttle'} isDisabled={readOnly} onChange={(x) => setV({ ...v, traffic: { throttleMbps: 10, ...v.traffic, overLimit: x as 'throttle' } })}
          options={[{ id: 'throttle', label: t('overLimitThrottle') }, { id: 'notify', label: t('overLimitNotify') }]}/>
        {(v.traffic?.overLimit ?? 'throttle') === 'throttle' && <NumberInput label={t('throttleMbps')} value={v.traffic?.throttleMbps ?? 10} minValue={1} maxValue={10000} isDisabled={readOnly}
          onChange={(x) => setV({ ...v, traffic: { overLimit: 'throttle', ...v.traffic, throttleMbps: x ?? 10 } })} help={t('throttleHelp')}/>}
      </div>
    </FormSection>
    <FormSection title={t('updatesTitle')} description={t('updatesHelp')} icon={<I name="shield-check" size={16}/>}>
      <div className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
        <div><p className="text-sm font-medium">{t('guestUpdates')}</p><p className="text-xs text-muted">{t('guestUpdatesHelp')}</p></div>
        <SwitchInput label={<span className="sr-only">{t('guestUpdates')}</span>} isSelected={v.guestUpdates !== false} isDisabled={readOnly} onChange={(x) => setV({ ...v, guestUpdates: x })}/>
      </div>
    </FormSection>
    <FormSection title={t('hardware')} description={t('hardwareHelp')} icon={<I name="cpu" size={16}/>}>
      {(['cpuHotAdd', 'memoryHotAdd', 'nestedHv'] as const).map((k) => <div key={k} className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
        <div><p className="text-sm font-medium">{t(`hw.${k}`)}</p><p className="text-xs text-muted">{t(`hwHelp.${k}`)}</p></div>
        <SwitchInput label={<span className="sr-only">{t(`hw.${k}`)}</span>} isSelected={v.hardware[k]} isDisabled={readOnly}
          onChange={(x) => setV({ ...v, hardware: { ...v.hardware, [k]: x } })}/>
      </div>)}
      <Notice tone="default">{t('hardwareNote')}</Notice>
    </FormSection>
    {!readOnly && <FormActions><Button isPending={busy} onPress={save}><I name="check" size={16}/>{t('save')}</Button></FormActions>}
  </Card.Content></Card>;
}
