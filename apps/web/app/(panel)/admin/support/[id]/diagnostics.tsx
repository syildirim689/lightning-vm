"use client";
// Staff only: what the panel knew about a ticket's server at the moment the ticket was opened (state, shape,
// addresses, its last operations, the owner's unpaid invoices). The API sends it with the ticket to staff alone; an
// older API, a ticket without a server or a snapshot that could not be taken sends none, and nothing is drawn.
import NextLink from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { I } from '../../../../../components/icon';
import { Ago, Mono, StatusChip, type Tone } from '../../../../../components/ui';
import { useErrorText } from '../../../../../lib/api';
import { useMe } from '../../../../../lib/me';
import { can } from '../../../../../lib/permissions';
import { useApiQuery } from '../../../../../lib/query';
import { Copy } from '../../../server-extras';

// Every key may be missing: the snapshot is stored as it was taken, by whichever version of the API took it.
type Snapshot = {
  capturedAt?: string | null;
  server?: { id?: string; name?: string; state?: string; power?: string; platform?: string; location?: string; plan?: string | null; vcpu?: number; memoryMb?: number; diskGb?: number;
    image?: string | null; addresses?: string[]; locked?: boolean; pendingDeletion?: boolean; createdAt?: string | null; traffic?: { allowanceGb?: number; usedGb?: number; throttled?: boolean } } | null;
  operations?: { kind?: string; status?: string; errorCode?: string | null; createdAt?: string | null; finishedAt?: string | null }[] | null;
  unpaidInvoices?: number | null;
};
const opTone = (s?: string): Tone => (s === 'succeeded' ? 'success' : s === 'failed' ? 'danger' : s === 'cancelled' ? 'default' : 'accent');
const isDate = (v?: string | null): v is string => !!v && !Number.isNaN(Date.parse(v));
// A stored value the panel has a name for is shown by that name, anything else as it was stored.
type Loose = ((key: string) => string) & { has: (key: string) => boolean };
const say = (tr: unknown, key: string, raw: string) => ((tr as Loose).has(key) ? (tr as Loose)(key) : raw);

export function TicketDiagnostics({ id }: { id: string }) {
  const t = useTranslations('Support.diag');
  const ts = useTranslations('Servers');
  const tv = useTranslations('Vmware');
  const format = useFormatter();
  const { error } = useErrorText();
  const me = useMe();
  // The same read as the ticket page (one request, one cache entry).
  const data = useApiQuery<{ ticket?: { ownerEmail?: string }; diagnostics?: Snapshot | null }>(['support', 'ticket', id], `/support/tickets/${id}`).data;
  const d = data?.diagnostics;
  if (!d || typeof d !== 'object') return null;
  const s = d.server && typeof d.server === 'object' ? d.server : {};
  const ops = Array.isArray(d.operations) ? d.operations : [];
  const addresses = Array.isArray(s.addresses) ? s.addresses.filter((a) => typeof a === 'string' && a) : [];
  const when = (v: string) => format.dateTime(new Date(v), { dateStyle: 'medium', timeStyle: 'short' });
  const stateText = s.state ? `${say(ts, `state.${s.state}`, s.state)}${s.state === 'ready' && s.power ? ` · ${say(ts, `power.${s.power}`, s.power)}` : ''}` : null;
  const stateTone: Tone = s.state === 'ready' ? (s.power === 'poweredOn' ? 'success' : 'default') : s.state === 'error' || s.state === 'missing' ? 'danger' : 'accent';
  const size = typeof s.vcpu === 'number' && typeof s.memoryMb === 'number' && typeof s.diskGb === 'number' && (s.vcpu || s.memoryMb || s.diskGb)
    ? ts('size', { vcpu: s.vcpu, memory: s.memoryMb / 1024, disk: s.diskGb }) : null;
  const traffic = s.traffic && typeof s.traffic.allowanceGb === 'number' ? s.traffic : null;
  const facts: [string, React.ReactNode][] = [
    [t('state'), stateText && <span className="flex flex-wrap items-center gap-1.5"><StatusChip tone={stateTone}>{stateText}</StatusChip>
      {s.locked && <StatusChip tone="warning">{t('locked')}</StatusChip>}{s.pendingDeletion && <StatusChip tone="danger">{t('pendingDeletion')}</StatusChip>}</span>],
    [t('plan'), s.plan],
    [t('size'), size],
    [t('image'), s.image],
    [t('location'), s.location],
    [t('platform'), s.platform && say(tv, `kind.${s.platform}`, s.platform)],
    [t('traffic'), traffic && <span className="flex flex-wrap items-center gap-1.5 tabular-nums">{t('trafficValue', { used: traffic.usedGb ?? 0, allowance: traffic.allowanceGb ?? 0 })}
      {traffic.throttled && <StatusChip tone="warning">{t('throttled')}</StatusChip>}</span>],
    [t('created'), isDate(s.createdAt) && when(s.createdAt)],
  ];
  const shown = facts.filter(([, v]) => v !== null && v !== undefined && v !== false && v !== '');
  const unpaid = typeof d.unpaidInvoices === 'number' ? d.unpaidInvoices : null;
  const owner = data?.ticket?.ownerEmail;
  const heading = 'text-xs font-semibold uppercase tracking-wider text-muted';

  return <details className="group rounded-2xl border border-border bg-surface">
    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-2xl px-4 py-3 outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
      <I name="camera" size={16} className="shrink-0 text-muted"/>
      <span className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">{t('title')}</h2>
        <span className="block truncate text-xs text-muted">{[s.name, isDate(d.capturedAt) ? t('captured', { when: when(d.capturedAt) }) : null].filter(Boolean).join(' · ')}</span>
      </span>
      {stateText && <span className="hidden shrink-0 sm:block"><StatusChip tone={stateTone}>{stateText}</StatusChip></span>}
      <I name="chevron-down" size={16} className="shrink-0 text-muted transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none"/>
    </summary>
    <div className="flex flex-col gap-4 border-t border-separator px-4 py-4 text-sm">
      <p className="text-xs text-muted">{t('note')}{isDate(d.capturedAt) && <> (<Ago at={d.capturedAt}/>)</>}</p>
      {shown.length > 0 && <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {shown.map(([label, value]) => <div key={label} className="flex min-w-0 flex-col gap-0.5"><dt className="text-xs text-muted">{label}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd></div>)}
      </dl>}
      <section className="flex flex-col gap-1.5">
        <h3 className={heading}>{t('addresses')}</h3>
        {addresses.length === 0 ? <p className="text-xs text-muted">{t('noAddresses')}</p>
          : <ul className="flex flex-wrap gap-x-3 gap-y-1">{addresses.map((a) => <li key={a} className="flex min-w-0 items-center gap-0.5"><Mono>{a}</Mono><Copy text={a} label={a}/></li>)}</ul>}
      </section>
      <section className="flex flex-col gap-1.5">
        <h3 className={heading}>{t('operations')}</h3>
        {ops.length === 0 ? <p className="text-xs text-muted">{t('noOperations')}</p>
          : <ul className="flex flex-col divide-y divide-separator">{ops.map((o, i) => <li key={`${o.createdAt ?? ''}:${o.kind ?? ''}:${i}`} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{o.kind ? say(ts, `kind.${o.kind}`, o.kind) : '–'}</span>
                {o.status && <StatusChip tone={opTone(o.status)}>{say(ts, `opStatus.${o.status}`, o.status)}</StatusChip>}
                {isDate(o.createdAt) && <time dateTime={o.createdAt} className="ml-auto text-xs text-muted">{when(o.createdAt)}</time>}
              </span>
              {o.errorCode && <span className="text-xs text-danger [overflow-wrap:anywhere]">{ts('errorCode', { message: error({ code: o.errorCode }), code: o.errorCode })}</span>}
            </li>)}</ul>}
      </section>
      {unpaid !== null && <section className="flex flex-col gap-1.5">
        <h3 className={heading}>{t('invoices')}</h3>
        <p className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${unpaid > 0 ? 'text-warning' : 'text-xs text-muted'}`}>
          <span className="flex items-center gap-1.5">{unpaid > 0 && <I name="receipt-text" size={14} className="shrink-0"/>}{unpaid > 0 ? t('unpaid', { n: unpaid }) : t('unpaidNone')}</span>
          {unpaid > 0 && owner && can(me?.permissions, 'billing.view') && <NextLink href={`/admin/billing?status=unpaid&q=${encodeURIComponent(owner)}`}
            className="rounded text-xs font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent">{t('unpaidLink')}</NextLink>}
        </p>
      </section>}
      {s.id && <div><NextLink href={`/servers/${s.id}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg text-sm font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent">
        <I name="server" size={14}/>{t('openServer', { name: s.name || s.id })}<I name="arrow-right" size={14}/></NextLink></div>}
    </div>
  </details>;
}
