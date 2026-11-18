"use client";
import { Button, toast } from '@heroui/react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { I } from '../../../components/icon';
import { ButtonLink, ConfirmButton, Notice, Section, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { useApiForm } from '../../../lib/form';
import { useMe } from '../../../lib/me';
import { useApiAction, useApiQuery } from '../../../lib/query';

type Project = { id: string; name: string; servers: number };
// GET /reseller/summary, managedBy: the reseller this account belongs to (null for everybody else).
type ManagedBy = { name: string; email: string; brand: string | null; active: boolean; canLeave: boolean };

// For a reseller's customer: who manages the account, what that reseller can and cannot do, how to reach it, and the
// way out. Leaving is asked first, with what follows from it (the servers are billed to the customer from then on).
export function ManagedAccount() {
  const t = useTranslations('Account.managed');
  const tc = useTranslations('Order');
  const { error } = useErrorText();
  const client = useQueryClient();
  const router = useRouter();
  const me = useMe();
  const m = useApiQuery<{ managedBy?: ManagedBy | null }>(['reseller', 'summary'], '/reseller/summary').data?.managedBy;
  if (!m) return null;
  const name = m.name || m.brand || m.email;
  async function leave() {
    try {
      const r = await apiFetch<{ servers?: number }>('/reseller/leave', { method: 'POST' });
      toast.success(t('left', { servers: r?.servers ?? 0 }));
    } catch (e) {
      // Already out of the reseller's hands (staff did it meanwhile): said as such, and the page is read again.
      const gone = (e as { code?: string })?.code === 'NOT_MANAGED';
      toast.danger(gone ? t('gone') : error(e));
      if (!gone) throw e;
    }
    // Everything the reseller stood behind is read again: this card, the servers, billing, the brand around the page.
    for (const queryKey of [['reseller'], ['servers'], ['billing'], ['notifications'], ['activity']]) void client.invalidateQueries({ queryKey });
    router.refresh();
  }
  const list = (keys: readonly ('can1' | 'can2' | 'cannot1' | 'cannot2' | 'cannot3')[], icon: string, tone: string) => <ul className="flex flex-col gap-1.5 text-sm text-muted">
    {keys.map((k) => <li key={k} className="flex gap-2"><I name={icon} size={15} className={`mt-0.5 shrink-0 ${tone}`}/><span>{t(k)}</span></li>)}
  </ul>;
  return <Section title={t('title', { name })} description={t('intro')}>
    <div className="flex flex-col gap-4">
      {!m.active && <Notice tone="warning">{t('inactive')}</Notice>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div><h3 className="mb-2 text-sm font-medium">{t('canTitle')}</h3>{list(['can1', 'can2'], 'check', 'text-success')}</div>
        <div><h3 className="mb-2 text-sm font-medium">{t('cannotTitle')}</h3>{list(['cannot1', 'cannot2', 'cannot3'], 'x', 'text-danger')}</div>
      </div>
      <p className="text-sm">{t('contact')}: <a href={`mailto:${m.email}`} className="font-medium text-accent hover:underline">{m.email}</a></p>
      <p className="text-sm text-muted">{t('activity')} <NextLink href="/account?tab=activity" className="font-medium text-accent hover:underline">{t('activityOpen')}</NextLink></p>
      {/* Not offered to a staff member signed in as the customer: staff take a customer out from the reseller's own record. */}
      {m.canLeave && !me?.impersonatedBy && <div>
        <ConfirmButton variant="danger-soft" icon={<I name="log-out" size={16}/>} label={t('leave')} title={t('leaveTitle', { name })} confirmLabel={t('leave')} cancelLabel={tc('projects.cancel')} onConfirm={leave}
          body={<span className="flex flex-col gap-2"><span>{t('leaveBody1')}</span><span>{t('leaveBody2', { name })}</span><span>{t('leaveBody3')}</span></span>}/>
      </div>}
    </div>
  </Section>;
}

export function Projects() {
  const t = useTranslations('Order');
  const client = useQueryClient();
  const projects = useApiQuery<{ projects: Project[] }>(['projects'], '/projects').data?.projects;
  const [listRef] = useAutoAnimate<HTMLUListElement>();
  const f = useApiForm({ name: '' });
  const remove = useApiAction((id: string) => apiFetch(`/projects/${id}`, { method: 'DELETE' }), { invalidate: [['projects'], ['servers']], success: t('projects.removed') });
  return <Section title={t('projects.title')}>
    <div className="flex flex-col gap-4">
      {projects?.length === 0 && <p className="text-sm text-muted">{t('projects.empty')}</p>}
      {!!projects?.length && <ul ref={listRef} className="flex flex-col divide-y divide-separator rounded-lg border border-border">
        {projects.map((p) => <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
          <I name="folder" size={16} className="text-muted"/>
          <span className="min-w-0 flex-1"><span className="block truncate font-medium">{p.name}</span><span className="block text-xs text-muted">{t('projects.servers', { n: p.servers })}</span></span>
          {p.servers > 0 && <ButtonLink size="sm" variant="ghost" href={`/?project=${p.id}`}><I name="server" size={15}/><span className="sr-only sm:not-sr-only">{t('projects.show')}</span></ButtonLink>}
          <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={15}/>} label={<span className="sr-only sm:not-sr-only">{t('projects.remove')}</span>}
            title={t('projects.removeTitle', { name: p.name })} body={t('projects.removeBody', { n: p.servers })} confirmLabel={t('projects.remove')} cancelLabel={t('projects.cancel')}
            onConfirm={() => remove.mutateAsync(p.id).then(() => undefined)}/>
        </li>)}
      </ul>}
      <form className="flex flex-wrap items-start gap-3" noValidate
        onSubmit={async (e) => { e.preventDefault(); if (await f.submit('POST', '/projects')) { f.reset(); client.invalidateQueries({ queryKey: ['projects'] }); toast.success(t('projects.created')); } }}>
        <TextInput maxLength={100} className="min-w-60 flex-1" label={t('projects.name')} value={f.values.name} onChange={f.set('name')} error={f.fieldError('name')}/>
        <Button type="submit" variant="secondary" className="mt-6" isPending={f.busy}><I name="plus" size={16}/>{t('projects.create')}</Button>
      </form>
    </div>
  </Section>;
}
