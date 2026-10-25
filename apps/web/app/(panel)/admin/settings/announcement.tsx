"use client";
// The notice on every signed-in page: text in both languages, a tone, an optional link and time window.
import { Button, Card, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../../components/icon';
import { FormActions, FormSection, Notice, SelectInput, SwitchInput, TextInput } from '../../../../components/ui';
import { apiFetch, type ApiError, useErrorText } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Doc = { active: boolean; tone: 'info' | 'warning' | 'danger' | 'success'; textTr: string; textEn: string; link: string; startsAt: string | null; endsAt: string | null; live?: boolean };
// <input type="datetime-local"> wants local "YYYY-MM-DDTHH:mm"; the API stores ISO (UTC).
const toLocal = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : '');

export default function AnnouncementSettings({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.announcement');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<Doc>(['settings', 'announcement'], '/admin/settings/announcement').data;
  const [v, setV] = useState<Doc | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q && !v) setV(q); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return <p role="status" className="text-sm text-muted">…</p>;
  async function save() {
    setBusy(true); setFields({});
    try {
      setV(await apiFetch<Doc>('/admin/settings/announcement', { method: 'PUT', body: { ...v, startsAt: v!.startsAt ?? '', endsAt: v!.endsAt ?? '' } }));
      toast.success(t('saved')); client.invalidateQueries({ queryKey: ['announcement'] });
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  const dis = readOnly;
  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('title')} description={t('help')} icon={<I name="megaphone" size={16}/>}>
      <SwitchInput label={t('active')} isSelected={v.active} onChange={(x) => setV({ ...v, active: x })} isDisabled={dis}/>
      {v.active && v.live === false && <Notice tone="default">{t('notLive')}</Notice>}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextInput label={t('textTr')} value={v.textTr} onChange={(x) => setV({ ...v, textTr: x })} maxLength={300} isDisabled={dis} error={field(fields.textTr)} help={t('chars', { n: 300 - v.textTr.length })}/>
        <TextInput label={t('textEn')} value={v.textEn} onChange={(x) => setV({ ...v, textEn: x })} maxLength={300} isDisabled={dis} error={field(fields.textEn)} help={t('chars', { n: 300 - v.textEn.length })}/>
        <SelectInput label={t('tone')} value={v.tone} onChange={(x) => setV({ ...v, tone: x as Doc['tone'] })} isDisabled={dis}
          options={(['info', 'warning', 'danger', 'success'] as const).map((x) => ({ id: x, label: t(`tones.${x}`) }))}/>
        <TextInput label={t('link')} value={v.link} onChange={(x) => setV({ ...v, link: x })} isDisabled={dis} error={field(fields.link)} help={t('linkHelp')} placeholder="/admin/system"/>
        <TextInput label={t('startsAt')} type="datetime-local" value={toLocal(v.startsAt)} onChange={(x) => setV({ ...v, startsAt: fromLocal(x) || null })} isDisabled={dis} error={field(fields.startsAt)} help={t('optional')}/>
        <TextInput label={t('endsAt')} type="datetime-local" value={toLocal(v.endsAt)} onChange={(x) => setV({ ...v, endsAt: fromLocal(x) || null })} isDisabled={dis} error={field(fields.endsAt)} help={t('optional')}/>
      </div>
    </FormSection>
    {!readOnly && <FormActions><Button isPending={busy} onPress={save}><I name="check" size={16}/>{t('save')}</Button></FormActions>}
  </Card.Content></Card>;
}
