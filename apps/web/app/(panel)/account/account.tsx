"use client";
import { Button, toast } from '@heroui/react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { I } from '../../../components/icon';
import { Section, TextInput } from '../../../components/ui';
import { apiFetch } from '../../../lib/api';
import { useApiForm } from '../../../lib/form';
import { useApiAction, useApiQuery } from '../../../lib/query';

type Project = { id: string; name: string };

export function Projects() {
  const t = useTranslations('Order');
  const client = useQueryClient();
  const projects = useApiQuery<{ projects: Project[] }>(['projects'], '/projects').data?.projects;
  const [listRef] = useAutoAnimate<HTMLUListElement>();
  const f = useApiForm({ name: '' });
  const remove = useApiAction((id: string) => apiFetch(`/projects/${id}`, { method: 'DELETE' }), { invalidate: [['projects']] });
  return <Section title={t('projects.title')}>
    <div className="flex flex-col gap-4">
      {projects?.length === 0 && <p className="text-sm text-muted">{t('projects.empty')}</p>}
      {!!projects?.length && <ul ref={listRef} className="flex flex-col divide-y divide-separator rounded-lg border border-border">
        {projects.map((p) => <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
          <I name="folder" size={16} className="text-muted"/><span className="flex-1 font-medium">{p.name}</span>
          <Button size="sm" variant="ghost" aria-label={`${t('projects.remove')}: ${p.name}`} onPress={() => remove.mutate(p.id)}><I name="trash-2" size={15}/>{t('projects.remove')}</Button>
        </li>)}
      </ul>}
      <form className="flex flex-wrap items-start gap-3" noValidate
        onSubmit={async (e) => { e.preventDefault(); if (await f.submit('POST', '/projects')) { f.reset(); client.invalidateQueries({ queryKey: ['projects'] }); toast.success(t('projects.created')); } }}>
        <TextInput className="min-w-60 flex-1" label={t('projects.name')} value={f.values.name} onChange={f.set('name')} error={f.fieldError('name')}/>
        <Button type="submit" variant="secondary" className="mt-6" isPending={f.busy}><I name="plus" size={16}/>{t('projects.create')}</Button>
      </form>
    </div>
  </Section>;
}
