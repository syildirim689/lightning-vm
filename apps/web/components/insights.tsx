"use client";
// Findings the API computed (capacity, IPs, connections, backups, security...), worst first, each with a
// link to where it is fixed. Severity is shown by icon and text, not colour alone. Each can be hidden for a while
// (critical ones for a day only) and the hidden ones shown again.
import { Button, Dropdown, Label } from '@heroui/react';
import { AnimatePresence, motion } from 'motion/react';
import NextLink from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { apiFetch } from '../lib/api';
import { useApiAction, useApiQuery } from '../lib/query';
import { I } from './icon';

type Insight = { code: string; severity: 'danger' | 'warning' | 'info'; params: Record<string, string | number | null>; link: string; key: string; action?: { kind: 'power_on' | 'restore'; serverId: string } };

export default function Insights({ scope }: { scope: 'staff' | 'mine' }) {
  const t = useTranslations('Insights');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const q = useApiQuery<{ insights: Insight[]; hidden: number }>(['insights', scope], scope === 'staff' ? '/admin/insights' : '/insights', { refetchInterval: 60_000 });
  const dismiss = useApiAction((v: { key: string; days: number | null }) => apiFetch('/insights/dismissals', { method: 'PUT', body: v }), { invalidate: [['insights']], success: t('hide.done') });
  // One-click fixes; the finding disappears on the next refresh once the server changed.
  const fix = useApiAction((a: NonNullable<Insight['action']>) => a.kind === 'restore'
    ? apiFetch(`/servers/${a.serverId}/deletion`, { method: 'DELETE' })
    : apiFetch(`/servers/${a.serverId}/actions`, { method: 'POST', body: { action: 'power_on' }, headers: { 'idempotency-key': crypto.randomUUID() } }),
  { invalidate: [['insights'], ['tasks'], ['servers']], success: t('fix.done') });
  const restore = useApiAction(() => apiFetch('/insights/dismissals', { method: 'DELETE' }), { invalidate: [['insights']] });
  const list = q.data?.insights;
  const hidden = q.data?.hidden ?? 0;
  if (!list) return null;
  const style = { danger: 'border-danger/40 bg-danger/5 text-danger', warning: 'border-warning/40 bg-warning/5 text-warning', info: 'border-border bg-surface text-accent' };
  const icon = (s: Insight['severity']) => s === 'danger' ? <I name="octagon-alert" size={18}/> : s === 'warning' ? <I name="triangle-alert" size={18}/> : <I name="lightbulb" size={18}/>;
  // A moment ("oldest") is said as "2 days ago"; one that cannot be read as "a while ago", so the sentence stays whole.
  const ago = (v: unknown) => { const at = typeof v === 'string' || typeof v === 'number' ? new Date(v).getTime() : NaN; return Number.isNaN(at) ? t('aWhileAgo') : format.relativeTime(new Date(Math.min(at, now.getTime())), now); };
  // A finding the panel has no text for yet (a newer API) is still said in words, never as its code.
  const text = (i: Insight, part: 'title' | 'body') => t.has(`codes.${i.code}.${part}` as 'codes.POOL_NEARLY_FULL.title') ? t(`codes.${i.code}.${part}` as 'codes.POOL_NEARLY_FULL.title', p(i)) : t(`unknown.${part}`);
  // Counts are numbers for the texts ("1 operation", "3 operations"), whichever way the API wrote them; a price is
  // written as money with its currency.
  const counts = ['count', 'n', 'days', 'hours', 'free', 'servers'];
  const p = (i: Insight): Record<string, string | number> => ({ oldest: ago(null), ...Object.fromEntries(Object.entries(i.params ?? {})
    .map(([k, v]) => [k, k === 'resource' ? t(`resource.${v}` as 'resource.vcpu') : k === 'oldest' ? ago(v)
      : counts.includes(k) && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v)
      : k === 'price' && v !== null && v !== '' && Number.isFinite(Number(v)) && typeof i.params.currency === 'string' && /^[A-Z]{3}$/.test(i.params.currency)
        ? format.number(Number(v), { style: 'currency', currency: i.params.currency }) : v ?? ''])) });
  return <section aria-labelledby={`insights-${scope}`} className="flex flex-col gap-3">
    <div className="flex items-center gap-2">
      <h2 id={`insights-${scope}`} className="text-base font-semibold">{t('title')}</h2>
      {list.length > 0 && <span className="rounded-full bg-default px-2 py-0.5 text-xs font-medium tabular-nums">{list.length}</span>}
    </div>
    {list.length === 0 ? <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 rounded-xl border border-success/40 bg-success/5 px-4 py-3 text-sm">
      <I name="circle-check" size={18} className="text-success"/>{t('allGood')}</motion.p>
      : <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        <AnimatePresence initial>{list.map((i, n) => <motion.li key={i.key} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ delay: n * 0.04 }} className="relative">
          <NextLink href={i.link} className={`group flex h-full items-start gap-3 rounded-xl border pl-4 pr-12 pt-3 transition-shadow ${i.action ? 'pb-14' : 'pb-3'} hover:shadow-md ${style[i.severity]}`}>
            <span className="mt-0.5 shrink-0">{icon(i.severity)}</span>
            <span className="min-w-0 flex-1 text-foreground">
              <span className="sr-only">{t(`severity.${i.severity}`)}: </span>
              <span className="block text-sm font-semibold">{text(i, 'title')}</span>
              <span className="block text-xs text-muted">{text(i, 'body')}</span>
            </span>
            <span aria-hidden className="mt-0.5 shrink-0 self-end text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent"><I name="arrow-right" size={14}/></span>
          </NextLink>
          {i.action && <Button size="sm" variant="secondary" className="absolute bottom-3 left-[2.875rem]" isPending={fix.isPending && fix.variables?.serverId === i.action.serverId}
            onPress={() => fix.mutate(i.action!)}>
            {i.action.kind === 'restore' ? <I name="undo-2" size={16}/> : <I name="power" size={16}/>}{t(`fix.${i.action.kind}`, { name: String(i.params.name ?? '') })}
          </Button>}
          <Dropdown>
            <Button isIconOnly variant="ghost" size="sm" aria-label={t('hide.menu', { title: text(i, 'title') })} className="absolute right-1.5 top-1.5 text-muted">
              <I name="eye-off" size={16}/>
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu aria-label={t('hide.label')} onAction={(k) => dismiss.mutate({ key: i.key, days: k === 'forever' ? null : Number(k) })}>
                <Dropdown.Item id="1" textValue={t('hide.day')}><Label>{t('hide.day')}</Label></Dropdown.Item>
                {i.severity !== 'danger' && <Dropdown.Item id="7" textValue={t('hide.week')}><Label>{t('hide.week')}</Label></Dropdown.Item>}
                {i.severity !== 'danger' && <Dropdown.Item id="forever" textValue={t('hide.forever')}><Label>{t('hide.forever')}</Label></Dropdown.Item>}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </motion.li>)}</AnimatePresence>
      </ul>}
    {hidden > 0 && <Button variant="ghost" size="sm" className="self-start text-muted" isPending={restore.isPending} onPress={() => restore.mutate()}>
      <I name="eye" size={16}/>{t('hide.restore', { count: hidden })}
    </Button>}
  </section>;
}
