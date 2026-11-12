"use client";
// Network discovery: scan IP blocks for ESXi and vCenter, see what each address is and whether the
// panel already knows it, and add a new one with the connection form filled in. An optional daily or
// weekly scan of the same blocks reports endpoints that appear later.
import { Button, Card, ProgressBar } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { I } from '../../../../components/icon';
import { ButtonLink, CheckboxInput, DataTable, Empty, Mono, Notice, SelectInput, Stat, StatusChip, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { useMe } from '../../../../lib/me';
import { can } from '../../../../lib/permissions';
import { useApiAction, useApiQuery } from '../../../../lib/query';
import { parseTargets } from '../../../../lib/scan-targets';
import { fingerprintPairs, type Prefill } from './connection-form';

type Product = { kind: 'esxi' | 'vcenter'; name: string; fullName: string; version: string; build: string; instanceUuid: string };
type Cert = { subject: string; issuer: string; notAfter: string; sha256: string; dnsNames: string[] | null; selfSigned: boolean; trustedName: string };
export type Hit = { address: string; state: 'vsphere' | 'https'; hostname: string | null; product: Product | null; certificate: Cert | null; key: string;
  status: 'new' | 'connected' | 'managed' | 'ignored' | 'other'; connection: { id: string; name: string } | null };
type Scan = { id: string; targets: string; port: number; auto: boolean; status: 'running' | 'done' | 'failed' | 'cancelled'; total: number; scanned: number; found: number;
  other: number; closed: number; silent: number; blocked: number; errorCode: string | null; startedAt: string; finishedAt: string | null; startedBy: string | null };
type Detail = { scan: Scan; hits: Hit[] };
type Settings = { targets: string; port: number; auto: 'off' | 'daily' | 'weekly'; notify: boolean };
type Overview = { settings: Settings; suggestions: { target: string; source: 'connection' | 'hosts' | 'recent'; label: string }[]; history: Scan[];
  ignored: { key: string; label: string | null }[]; latest: Detail | null; nextAuto: string | null };
type Filter = 'new' | 'known' | 'ignored' | 'other';

const inFilter = (h: Hit, f: Filter | null) => f === null ? h.status !== 'other'
  : f === 'known' ? h.status === 'connected' || h.status === 'managed' : h.status === f;
const soon = (iso: string) => Date.parse(iso) - Date.now() < 30 * 86_400_000;

// The connection form, filled in from what the scan saw: a name from the PTR record, the usual
// account for the product, and the certificate's trust (system CAs, or the fingerprint to compare).
// The address is the name the certificate is trusted for, else the IP the scan reached: a PTR name may not
// resolve forwards, or may not be a valid host name at all (Docker's "name.net_work").
export function prefillFrom(h: Hit, port: number): Prefill {
  const kind = h.product?.kind ?? 'esxi';
  const trusted = h.certificate?.trustedName ?? '';
  return { name: (h.hostname?.split('.')[0] || `${kind === 'vcenter' ? 'vcenter' : 'esxi'}-${h.address.replaceAll(':', '-')}`).slice(0, 100),
    host: trusted || h.address, port: String(port), username: kind === 'vcenter' ? 'administrator@vsphere.local' : 'root',
    mode: trusted ? 'system' : 'pinned', sha256: trusted ? '' : h.certificate?.sha256 ?? '', kind };
}

export default function Discovery({ onAdd }: { onAdd: (p: Prefill) => void }) {
  const t = useTranslations('Vmware.scan');
  const tv = useTranslations('Vmware');
  const format = useFormatter();
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const manage = can(useMe()?.permissions, 'vmware.manage');
  const overview = useApiQuery<Overview>(['vmware', 'scan'], '/admin/vmware/scan').data;
  const [targets, setTargets] = useState<string | null>(null);
  const [port, setPort] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [auto, setAuto] = useState<Settings | null>(null);
  const text = targets ?? overview?.settings.targets ?? '';
  const portText = port ?? String(overview?.settings.port ?? 443);
  const shown = viewing ?? overview?.latest?.scan.id ?? null;
  const detail = useApiQuery<Detail>(['vmware', 'scan', shown], shown ? `/admin/vmware/scans/${shown}` : null,
    { refetchInterval: (d) => d?.scan.status === 'running' ? 1500 : false }).data;
  const scan = detail?.scan;
  const running = scan?.status === 'running';

  // When a scan finishes, the history, suggestions and connection list catch up once.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) client.invalidateQueries({ queryKey: ['vmware', 'scan'], exact: true });
    wasRunning.current = running;
  }, [running, client]);

  const parsed = useMemo(() => parseTargets(text), [text]);
  const bad = parsed.items.find((i) => i.error);
  const localError = bad ? t('itemError', { item: bad.text, reason: field(bad.error) ?? '' }) : parsed.tooMany ? field('TOO_MANY_ADDRESSES') : undefined;

  const start = useApiAction(() => apiFetch<{ id: string }>('/admin/vmware/scans', { method: 'POST', body: { targets: text, port: Number(portText) } }), {
    invalidate: [['vmware', 'scan']],
    onSuccess: (r) => { setViewing(r.id); setFilter(null); setFieldErrors({}); },
  });
  useEffect(() => { if (start.error) setFieldErrors((start.error as ApiError).fields ?? {}); }, [start.error]);
  const cancel = useApiAction((id: string) => apiFetch(`/admin/vmware/scans/${id}/cancel`, { method: 'POST' }), { invalidate: [['vmware', 'scan']], success: t('cancelled') });
  const ignore = useApiAction((h: Hit) => apiFetch('/admin/vmware/scan/ignore', { method: 'POST', body: { key: h.key, label: h.hostname || h.address } }),
    { invalidate: [['vmware', 'scan']], success: t('ignoredToast') });
  const unignore = useApiAction((key: string) => apiFetch('/admin/vmware/scan/unignore', { method: 'POST', body: { key } }), { invalidate: [['vmware', 'scan']] });
  const settings = auto ?? overview?.settings;
  const saveAuto = useApiAction((s: Settings) => apiFetch<Settings>('/admin/vmware/scan/settings', { method: 'PUT', body: s }),
    { invalidate: [['vmware', 'scan']], success: t('auto.saved'), onSuccess: () => setAuto(null) });

  const addSuggestion = (target: string) => {
    const lines = text.split(/[\s,;]+/).filter(Boolean);
    if (!lines.includes(target)) setTargets([...lines, target].join('\n'));
  };
  const hits = detail?.hits ?? [];
  const count = (f: Filter) => hits.filter((h) => inFilter(h, f)).length;
  const rows = hits.filter((h) => inFilter(h, filter));
  const pct = scan && scan.total ? Math.round((scan.scanned / scan.total) * 100) : 0;
  const busy = (h: Hit) => (ignore.isPending && ignore.variables?.key === h.key) || (unignore.isPending && unignore.variables === h.key);

  if (!overview) return <p role="status" className="text-sm text-muted">{tv('loading')}</p>;

  return <Card id="discovery">
    <Card.Header>
      <Card.Title className="flex items-center gap-2"><I name="radar" size={18} className="text-accent"/>{t('title')}</Card.Title>
      <Card.Description>{t('intro')}</Card.Description>
    </Card.Header>
    <Card.Content className="flex flex-col gap-5">
      {manage && <form className="flex flex-col gap-3" noValidate onSubmit={(e) => { e.preventDefault(); if (!localError && parsed.addresses.length && !running) start.mutate(); }}>
        <div className="grid gap-3 md:grid-cols-[1fr_8rem]">
          <TextInput multiline label={t('targets')} value={text} onChange={(v) => { setTargets(v); setFieldErrors({}); }} spellCheck={false}
            placeholder={'192.168.10.0/24\n10.0.0.20-10.0.0.60'} error={text ? localError ?? field(fieldErrors.targets) : field(fieldErrors.targets)}
            help={parsed.addresses.length ? t('count', { count: parsed.addresses.length }) : t('targetsHelp')}/>
          <TextInput label={t('port')} value={portText} onChange={setPort} error={field(fieldErrors.port)} help={t('portHelp')}/>
        </div>
        {overview.suggestions.length > 0 && <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">{t('suggested')}</span>
          {overview.suggestions.map((s) => <Button key={s.target} size="sm" variant="secondary" onPress={() => addSuggestion(s.target)}
            aria-label={t('addSuggestion', { target: s.target, why: s.label ? t(`source.${s.source}`, { name: s.label }) : t('source.recent') })}>
            <I name="plus" size={14}/><span className="font-mono">{s.target}</span>{s.label && <span className="text-muted">· {s.label}</span>}
          </Button>)}
        </div>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" isDisabled={!!localError || !parsed.addresses.length || running} isPending={start.isPending}>
            <I name="radar" size={16}/>{t('start')}</Button>
          {running && <span className="text-sm text-muted">{t('oneAtATime')}</span>}
        </div>
      </form>}

      {scan && <div className="flex flex-col gap-3">
        {running ? <div className="flex flex-col gap-2 rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" aria-atomic="true" className="text-sm font-medium">{t('progress', { scanned: scan.scanned, total: scan.total, found: scan.found })}</p>
            {manage && <Button size="sm" variant="secondary" isPending={cancel.isPending} onPress={() => cancel.mutate(scan.id)}><I name="square" size={14}/>{t('cancel')}</Button>}
          </div>
          <ProgressBar aria-label={t('progressLabel')} value={pct} size="sm" color="accent"><ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>
          <p className="break-all font-mono text-xs text-muted">{scan.targets}</p>
        </div>
        : <div role="status" className="flex flex-col gap-1 text-sm">
          <p className="font-medium">{scan.status === 'done' ? t('doneSummary', { total: scan.total, found: scan.found, other: scan.other })
            : scan.status === 'cancelled' ? t('cancelledSummary', { scanned: scan.scanned, total: scan.total, found: scan.found })
            : t('failedSummary', { reason: error({ code: scan.errorCode }) })}</p>
          <p className="text-muted">
            {[format.relativeTime(new Date(Math.min(Date.parse(scan.startedAt), Date.now())), new Date()), scan.auto ? t('auto.byAuto') : scan.startedBy,
              scan.finishedAt && t('took', { seconds: Math.max(1, Math.round((Date.parse(scan.finishedAt) - Date.parse(scan.startedAt)) / 1000)) })].filter(Boolean).join(' · ')}
            {' · '}<span className="break-all font-mono">{scan.targets}</span>
          </p>
          {scan.blocked > 0 && <p className="text-warning">{t('blocked', { count: scan.blocked })}</p>}
        </div>}

        {hits.length > 0 && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={t('tile.new')} value={count('new')} tone={count('new') ? 'accent' : 'default'} icon={<I name="sparkles" size={18}/>} pressed={filter === 'new'} onPress={() => setFilter(filter === 'new' ? null : 'new')}/>
          <Stat label={t('tile.known')} value={count('known')} tone="success" icon={<I name="link" size={18}/>} pressed={filter === 'known'} onPress={() => setFilter(filter === 'known' ? null : 'known')}/>
          <Stat label={t('tile.ignored')} value={count('ignored')} icon={<I name="eye-off" size={18}/>} pressed={filter === 'ignored'} onPress={() => setFilter(filter === 'ignored' ? null : 'ignored')}/>
          <Stat label={t('tile.other')} value={count('other')} icon={<I name="globe" size={18}/>} hint={t('tile.otherHint')} pressed={filter === 'other'} onPress={() => setFilter(filter === 'other' ? null : 'other')}/>
        </div>}

        {rows.length === 0 ? (!running && <Empty icon={<I name="radar" size={28}/>} title={filter ? t('emptyFilter') : t('empty')}>
          {!filter && scan.status === 'done' && <ul className="list-disc pl-5 text-left text-sm text-muted">
            <li>{t('emptyHint.port', { port: scan.port })}</li><li>{t('emptyHint.firewall')}</li><li>{t('emptyHint.ranges')}</li>
          </ul>}
          {filter && <Button size="sm" variant="secondary" onPress={() => setFilter(null)}>{t('clearFilter')}</Button>}
        </Empty>)
        : <DataTable label={t('results')} rows={rows} rowKey={(h) => h.address} minWidth={820}
          columns={[{ id: 'a', label: t('col.address') }, { id: 'p', label: t('col.product') }, { id: 'c', label: t('col.certificate') }, { id: 's', label: t('col.status') },
            { id: 'x', label: <span className="sr-only">{t('col.actions')}</span> }]}
          cells={(h) => [
            <span key="a" className="flex min-w-0 flex-col"><Mono>{h.address}</Mono>{h.hostname && <span className="break-all text-xs text-muted">{h.hostname}</span>}</span>,
            h.product ? <span key="p" className="flex flex-col"><span className="font-medium">{h.product.kind === 'vcenter' ? 'vCenter' : 'ESXi'} {h.product.version}</span>
              <span className="text-xs text-muted">{t('build', { build: h.product.build })}</span></span>
              : <span key="p" className="text-muted">{t('notVsphere')}</span>,
            !h.certificate ? '–' : <span key="c" className="flex flex-col items-start gap-1" title={`SHA-256 ${fingerprintPairs(h.certificate.sha256)}`}>
              {h.certificate.trustedName ? <StatusChip tone="success">{t('cert.trusted')}</StatusChip>
                : <StatusChip tone="warning">{h.certificate.selfSigned ? t('cert.selfSigned') : t('cert.untrusted')}</StatusChip>}
              {soon(h.certificate.notAfter) && <span className="text-xs text-danger">{t('cert.expires', { date: format.dateTime(new Date(h.certificate.notAfter), { dateStyle: 'medium' }) })}</span>}
            </span>,
            h.status === 'new' ? <StatusChip key="s" tone="accent">{t('status.new')}</StatusChip>
              : h.status === 'ignored' ? <StatusChip key="s" tone="default">{t('status.ignored')}</StatusChip>
              : h.status === 'other' ? <span key="s" className="text-muted">–</span>
              : <span key="s" className="flex flex-col items-start gap-1"><StatusChip tone="success">{t(`status.${h.status}`)}</StatusChip>
                <a className="text-xs text-accent hover:underline" href={`/admin/vmware/${h.connection!.id}`}>{h.connection!.name}</a></span>,
            <span key="x" className="flex justify-end gap-1">
              {manage && h.status === 'new' && <>
                <Button size="sm" onPress={() => onAdd(prefillFrom(h, scan.port))}><I name="plus" size={14}/>{t('add')}</Button>
                <Button size="sm" variant="ghost" isIconOnly aria-label={t('ignore', { address: h.address })} isPending={busy(h)} onPress={() => ignore.mutate(h)}><I name="eye-off" size={14}/></Button>
              </>}
              {manage && h.status === 'ignored' && <Button size="sm" variant="secondary" isPending={busy(h)} onPress={() => unignore.mutate(h.key)}>{t('unignore')}</Button>}
              {(h.status === 'connected' || h.status === 'managed') && <ButtonLink size="sm" variant="secondary" href={`/admin/vmware/${h.connection!.id}`}>{tv('details')}</ButtonLink>}
            </span>]}/>}
      </div>}

      {!scan && !manage && <Empty icon={<I name="radar" size={28}/>} title={t('none')}/>}

      {manage && settings && <details className="group rounded-xl border border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 text-sm font-medium">
          <span className="flex items-center gap-2"><I name="calendar-clock" size={16}/>{t('auto.title')}</span>
          <span className="text-xs font-normal text-muted">{overview.settings.auto === 'off' ? t('auto.offShort')
            : t('auto.next', { when: overview.nextAuto ? format.relativeTime(new Date(overview.nextAuto), new Date()) : '–', every: t(`auto.${overview.settings.auto}`) })}</span>
        </summary>
        <div className="flex flex-col gap-3 border-t border-border p-4">
          <p className="text-sm text-muted">{t('auto.help')}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <SelectInput label={t('auto.every')} value={settings.auto} onChange={(v) => setAuto({ ...settings, auto: v as Settings['auto'] })}
              options={(['off', 'daily', 'weekly'] as const).map((v) => ({ id: v, label: t(`auto.${v}`) }))}/>
            <CheckboxInput label={t('auto.notify')} isSelected={settings.notify} onChange={(v) => setAuto({ ...settings, notify: v })} help={t('auto.notifyHelp')}/>
          </div>
          <p className="text-sm">{settings.targets
            ? <>{t('auto.covers')} <span className="break-all font-mono">{settings.targets.split(/[\s,;]+/).filter(Boolean).join(', ')}</span></>
            : <span className="text-warning">{t('auto.noTargets')}</span>}</p>
          <div className="flex flex-wrap gap-2">
            {text && text !== settings.targets && <Button size="sm" variant="secondary" isDisabled={!!localError} onPress={() => setAuto({ ...settings, targets: text, port: Number(portText) || 443 })}>
              <I name="copy" size={14}/>{t('auto.useAbove')}</Button>}
            <Button size="sm" isDisabled={!auto} isPending={saveAuto.isPending} onPress={() => saveAuto.mutate(settings)}><I name="check" size={14}/>{t('auto.save')}</Button>
          </div>
        </div>
      </details>}

      {overview.history.length > 1 && <details className="rounded-xl border border-border">
        <summary className="cursor-pointer list-none p-4 text-sm font-medium"><span className="flex items-center gap-2"><I name="history" size={16}/>{t('history', { count: overview.history.length })}</span></summary>
        <ul className="flex flex-col divide-y divide-border border-t border-border">
          {overview.history.map((s) => <li key={s.id}>
            <button type="button" aria-current={s.id === shown} onClick={() => { setViewing(s.id); setFilter(null); }}
              className={`flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left text-sm hover:bg-default ${s.id === shown ? 'bg-default' : ''}`}>
              <span className="min-w-0 break-all font-mono text-xs">{s.targets}</span>
              <span className="flex items-center gap-2 text-xs text-muted">
                {s.auto && <StatusChip tone="default">{t('auto.badge')}</StatusChip>}
                <StatusChip tone={s.status === 'done' ? 'success' : s.status === 'running' ? 'accent' : s.status === 'failed' ? 'danger' : 'default'}>{t(`state.${s.status}`)}</StatusChip>
                {t('found', { count: s.found })} · {format.relativeTime(new Date(Math.min(Date.parse(s.startedAt), Date.now())), new Date())}
              </span>
            </button>
          </li>)}
        </ul>
      </details>}

      {manage && overview.ignored.length > 0 && filter !== 'ignored' && <p className="text-xs text-muted">{t('ignoredCount', { count: overview.ignored.length })}</p>}
      {scan?.status === 'failed' && scan.errorCode === 'VMWARE_SERVICE_UNAVAILABLE' && <Notice tone="danger" title={t('adapterDown')}/>}
    </Card.Content>
  </Card>;
}
