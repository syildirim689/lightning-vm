"use client";
// "What next" on a server's page (GET /servers/:id/hints, rules in apps/api/src/server-hint-rules.ts): a few things
// worth doing, read from the server's real state. Each leads to the part of the page (or the page) where it is done
// and nothing is done from here; each can be hidden for a week or for good (the viewer's own insight dismissals).
// Severity is said in words and by icon, not by colour alone.
import { Button, Dropdown, Label } from '@heroui/react';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { apiFetch } from '../lib/api';
import { useApiAction, useApiQuery } from '../lib/query';
import { I } from './icon';

type Hint = { code: 'NO_BACKUP' | 'NO_FIREWALL' | 'ROOT_PASSWORD_KEPT' | 'SNAPSHOTS_OLD'; severity: 'warning' | 'info'; key: string;
  params: Record<string, string | number | null>; action: { section: 'backups' | 'firewalls' | 'rootPassword' | 'snapshots' } | { href: string } };

const severityIcons = { warning: 'triangle-alert', info: 'lightbulb' } as const;
const severityIcon: Record<Hint['severity'], string> = severityIcons;

export function ServerHints({ id }: { id: string }) {
  const t = useTranslations('ServerHints');
  const tb = useTranslations('Backups');
  const ts = useTranslations('Snapshots');
  const tp = useTranslations('Servers.password');
  const key = ['servers', id, 'hints'];
  const q = useApiQuery<{ hints: Hint[]; hidden: number }>(key, `/servers/${id}/hints`, { refetchInterval: 120_000 });
  const hide = useApiAction((v: { key: string; days: number | null }) => apiFetch('/insights/dismissals', { method: 'PUT', body: v }), { invalidate: [key, ['insights']], success: t('hidden') });
  const list = q.data?.hints ?? [];
  if (!list.length) return null;
  // The parts of the page are found by their title, as the page's own section menu finds them.
  const titles = { backups: tb('title'), snapshots: ts('title'), rootPassword: tp('title'), firewalls: '' };
  const go = (section: keyof typeof titles) => {
    const el = document.querySelector<HTMLElement>(`[data-section="${CSS.escape(titles[section])}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    // Keyboard and screen reader users land where the eye does: the section's first control.
    el.querySelector<HTMLElement>('button:not([disabled]), a[href], input:not([disabled])')?.focus({ preventScroll: true });
  };
  const params = (h: Hint) => ({ ...Object.fromEntries(Object.entries(h.params).map(([k, v]) => [k, v ?? ''])), never: h.params.days === null ? 'yes' : 'no' });
  return <section aria-labelledby={`hints-${id}`} className="flex flex-col gap-2" data-hints>
    <h2 id={`hints-${id}`} className="flex items-center gap-2 text-sm font-semibold"><I name="list-todo" size={16} className="text-accent"/>{t('title')}</h2>
    <ul className="grid gap-2 md:grid-cols-2">
      {list.map((h) => <li key={h.key} data-hint={h.code} className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 ${h.severity === 'warning' ? 'border-warning/40 bg-warning/5' : 'border-border bg-surface'}`}>
        <I name={severityIcon[h.severity]} size={18} className={`mt-0.5 shrink-0 ${h.severity === 'warning' ? 'text-warning' : 'text-accent'}`}/>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="text-sm"><span className="sr-only">{t(`severity.${h.severity}`)}: </span><span className="font-medium">{t(`${h.code}.title`, params(h))}</span>
            <span className="block text-xs text-muted">{t(`${h.code}.body`, params(h))}</span></p>
          <div className="flex flex-wrap items-center gap-2">
            {'href' in h.action ? <NextLink href={h.action.href} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-default px-3 text-sm font-medium hover:bg-default/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              {t(`${h.code}.action`)}<I name="arrow-right" size={14}/></NextLink>
              : <Button size="sm" variant="secondary" onPress={() => go((h.action as { section: keyof typeof titles }).section)}>{t(`${h.code}.action`)}<I name="arrow-down" size={14}/></Button>}
            <Dropdown>
              <Button size="sm" variant="ghost" className="text-muted" aria-label={t('hideMenu', { title: t(`${h.code}.title`, params(h)) })}><I name="eye-off" size={14}/>{t('hide')}</Button>
              <Dropdown.Popover placement="bottom start">
                <Dropdown.Menu aria-label={t('hide')} onAction={(k) => hide.mutate({ key: h.key, days: k === 'forever' ? null : 7 })}>
                  <Dropdown.Item id="7" textValue={t('week')}><Label>{t('week')}</Label></Dropdown.Item>
                  <Dropdown.Item id="forever" textValue={t('forever')}><Label>{t('forever')}</Label></Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </div>
        </div>
      </li>)}
    </ul>
    <p className="text-xs text-muted">{t('basis')}</p>
  </section>;
}
