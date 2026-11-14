"use client";
// Settings → Support: the departments customers choose from (names in both languages, order, on/off). Removing one
// keeps its tickets, without a department.
import { Button, Card, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../../components/icon';
import { FormActions, FormSection, SwitchInput, TextInput, Loading } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Dep = { id?: string; nameTr: string; nameEn: string; active: boolean; open?: number };

export default function SupportDepartments({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.support');
  const ts = useTranslations('Settings');
  const { error } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ departments: Dep[] }>(['admin', 'support', 'departments'], '/admin/support/departments');
  const [list, setList] = useState<Dep[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data && !list) setList(q.data.departments); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list) return <Loading of={['admin', 'support', 'departments']}/>;
  const set = (i: number, patch: Partial<Dep>) => setList(list.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const move = (i: number, by: number) => { const next = [...list]; const [d] = next.splice(i, 1); next.splice(i + by, 0, d); setList(next); };
  async function save() {
    setBusy(true);
    try { const r = await apiFetch<{ departments: Dep[] }>('/admin/support/departments', { method: 'PUT', body: { departments: list } }); setList(r.departments); toast.success(ts('saved')); void client.invalidateQueries({ queryKey: ['support', 'departments'] }); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('departments')} description={t('departmentsHelp')} icon={<I name="life-buoy" size={16}/>}>
      <ul className="flex flex-col gap-3">{list.map((d, i) => <li key={d.id ?? `new-${i}`} className="flex flex-col gap-3 rounded-xl border border-border p-3 lg:flex-row lg:items-end">
        <TextInput className="flex-1" label={t('nameTr')} value={d.nameTr} onChange={(x) => set(i, { nameTr: x })} maxLength={60} isDisabled={readOnly}/>
        <TextInput className="flex-1" label={t('nameEn')} value={d.nameEn} onChange={(x) => set(i, { nameEn: x })} maxLength={60} isDisabled={readOnly}/>
        <div className="flex items-center gap-1 lg:pb-1">
          <SwitchInput label={t('active')} isSelected={d.active} onChange={(x) => set(i, { active: x })} isDisabled={readOnly}/>
          {!readOnly && <>
            <Button isIconOnly size="sm" variant="ghost" aria-label={t('up')} isDisabled={i === 0} onPress={() => move(i, -1)}><I name="arrow-up" size={14}/></Button>
            <Button isIconOnly size="sm" variant="ghost" aria-label={t('down')} isDisabled={i === list.length - 1} onPress={() => move(i, 1)}><I name="arrow-down" size={14}/></Button>
            <Button isIconOnly size="sm" variant="ghost" aria-label={t('remove')} onPress={() => setList(list.filter((_, j) => j !== i))}><I name="trash-2" size={14}/></Button>
          </>}
        </div>
        {!!d.open && <p className="text-xs text-muted lg:pb-2">{t('openTickets', { n: d.open })}</p>}
      </li>)}</ul>
      {!readOnly && <div><Button size="sm" variant="secondary" onPress={() => setList([...list, { nameTr: '', nameEn: '', active: true }])}><I name="plus" size={14}/>{t('add')}</Button></div>}
    </FormSection>
    {!readOnly && <FormActions><Button isPending={busy} isDisabled={list.some((d) => !d.nameTr.trim() || !d.nameEn.trim())} onPress={save}><I name="check" size={16}/>{ts('save')}</Button></FormActions>}
  </Card.Content></Card>;
}
