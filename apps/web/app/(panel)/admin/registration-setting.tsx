"use client";
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Section, SwitchInput } from '../../../components/ui';
import { apiFetch } from '../../../lib/api';
import { useApiAction, useApiQuery } from '../../../lib/query';

export default function RegistrationSetting() {
  const t = useTranslations('AdminPanel');
  const client = useQueryClient();
  const settings = useApiQuery<{ registrationOpen: boolean }>(['admin', 'settings'], '/admin/settings').data;
  const save = useApiAction((value: boolean) => apiFetch<{ registrationOpen: boolean }>('/admin/settings', { method: 'PUT', body: { registrationOpen: value } }),
    { success: t('saved'), onSuccess: (r) => { client.setQueryData(['admin', 'settings'], r); void client.invalidateQueries({ queryKey: ['settings', 'overview'] }); } });
  return <Section title={t('registrationTitle')} description={t('registrationHelp')}>
    <SwitchInput label={t('registrationOpen')} isSelected={settings?.registrationOpen ?? false} isDisabled={!settings || save.isPending} onChange={(v) => save.mutate(v)}/>
  </Section>;
}
