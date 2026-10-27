"use client";
// Admin → System → This server: the panel host's name, clock and time zone, time servers (NTP) and DNS servers.
// The API only drops a request; the host agent (scripts/install.sh host) checks it again and applies it with
// hostnamectl, timedatectl, systemd-timesyncd and systemd-resolved, then records the result for this page.
import { Button, Chip, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { I } from '../../../components/icon';
import TimeZonePicker from '../../../components/time-zone-picker';
import { ConfirmButton, Mono, Notice, Section, StatusChip, TextInput, type Tone } from '../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../lib/api';
import { useMe } from '../../../lib/me';
import { can } from '../../../lib/permissions';
import { useApiQuery } from '../../../lib/query';

type Host = { checkedAt: string; time: number; hostname: string; fqdn: string; timezone: string; ntp: string; ntpSynced: string; ntpServers: string; dnsServers: string; resolvers: string;
  timesyncd: boolean; resolved: boolean; os: string; kernel: string; uptime: number };
type Status = { id: string; state: 'running' | 'succeeded' | 'failed' | 'rejected'; startedAt: string; code: string };
type Data = { host: Host | null; serverTime: number; agent: { installed: boolean; pending: number; status: Status | null; log: string[] } };
const stateTone: Record<Status['state'], Tone> = { running: 'accent', succeeded: 'success', failed: 'danger', rejected: 'danger' };

export default function HostSettings() {
  const t = useTranslations('HostSettings');
  const format = useFormatter();
  const now = useNow({ updateInterval: 1000 });
  const { error, field } = useErrorText();
  const me = useMe();
  const client = useQueryClient();
  const manage = can(me?.permissions, 'system.update');
  const [watching, setWatching] = useState(false);
  const q = useApiQuery<Data>(['admin', 'host'], '/admin/host', { refetchInterval: watching ? 3_000 : 60_000 });
  const d = q.data;
  // Clock offset: the server's time when it answered against this browser's time when the answer arrived.
  const receivedAt = useRef(0);
  useEffect(() => { if (d) receivedAt.current = Date.now(); }, [d]);
  useEffect(() => { setWatching(!!d && (d.agent.pending > 0 || d.agent.status?.state === 'running')); }, [d]);
  const [v, setV] = useState({ hostname: '', timezone: '', ntp: '', dns: '' });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const seeded = useRef(false);
  useEffect(() => {
    if (!d?.host || seeded.current) return;
    seeded.current = true;
    setV({ hostname: d.host.fqdn || d.host.hostname, timezone: d.host.timezone, ntp: d.host.ntpServers, dns: d.host.dnsServers });
  }, [d]);

  if (!d) return <Section title={t('title')}><p role="status" className="text-sm text-muted">{q.error ? error(q.error) : '…'}</p></Section>;
  const h = d.host;
  const drift = receivedAt.current ? Math.round((d.serverTime - receivedAt.current) / 1000) : 0;
  const serverNow = new Date(now.getTime() + drift * 1000);
  const st = d.agent.status;
  const synced = h?.ntpSynced === 'yes';
  const changed = h ? { ...(v.hostname && v.hostname !== (h.fqdn || h.hostname) && { hostname: v.hostname }), ...(v.timezone && v.timezone !== h.timezone && { timezone: v.timezone }),
    ...(v.ntp !== h.ntpServers && { ntp: v.ntp || 'default' }), ...(v.dns !== h.dnsServers && { dns: v.dns || 'default' }) } : {};

  async function send(body: Record<string, string>, done: string) {
    setBusy(true); setFields({});
    try { await apiFetch('/admin/host', { method: 'POST', body }); toast.success(done); setWatching(true); seeded.current = false; void client.invalidateQueries({ queryKey: ['admin', 'host'] }); }
    catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  const blocked = !manage || !d.agent.installed || watching || busy;
  const days = h ? Math.floor(h.uptime / 86400) : 0, hours = h ? Math.floor((h.uptime % 86400) / 3600) : 0;

  return <Section title={t('title')} description={t('intro')}
    actions={manage && <Button size="sm" variant="secondary" isDisabled={blocked} onPress={() => send({}, t('refreshQueued'))}><I name="refresh-cw" size={14}/>{t('refresh')}</Button>}>
    <div className="flex flex-col gap-5">
      {!d.agent.installed && <Notice tone="warning" title={t('agentMissingTitle')}>{t('agentMissing')} <Mono>sudo sh scripts/install.sh agent on</Mono></Notice>}
      {d.agent.installed && !h && <Notice tone="default">{t('noDetails')}</Notice>}

      {/* The clock: this server's time, ticking, and how far it is from this computer's. */}
      <div className="grid gap-4 md:grid-cols-[auto_minmax(0,1fr)]">
        <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center justify-center rounded-3xl border border-border bg-gradient-to-br from-accent/10 to-transparent px-8 py-5 text-center">
          <p className="text-xs uppercase tracking-wider text-muted">{t('serverClock')}</p>
          <p className="text-4xl font-semibold tabular-nums tracking-tight">{format.dateTime(serverNow, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: h?.timezone || 'UTC' })}</p>
          <p className="text-xs text-muted">{format.dateTime(serverNow, { weekday: 'long', day: 'numeric', month: 'long', timeZone: h?.timezone || 'UTC' })} · {h?.timezone || 'UTC'}</p>
          <div className="mt-2 flex flex-wrap justify-center gap-1.5">
            {h && <StatusChip tone={synced ? 'success' : 'warning'}><I name={synced ? 'circle-check' : 'triangle-alert'} size={12}/> {t(synced ? 'synced' : 'notSynced')}</StatusChip>}
            <StatusChip tone={Math.abs(drift) > 5 ? 'warning' : 'default'}>{Math.abs(drift) <= 1 ? t('driftNone') : t(drift > 0 ? 'driftAhead' : 'driftBehind', { s: Math.abs(drift) })}</StatusChip>
          </div>
        </motion.div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
          <Fact label={t('hostname')}>{h ? <Mono>{h.fqdn || h.hostname}</Mono> : '–'}</Fact>
          <Fact label={t('os')}>{h?.os || '–'}</Fact>
          <Fact label={t('kernel')}>{h?.kernel ? <Mono>{h.kernel}</Mono> : '–'}</Fact>
          <Fact label={t('uptime')}>{h ? t('uptimeValue', { days, hours }) : '–'}</Fact>
          <Fact label={t('ntpServers')}>{h?.ntpServers ? h.ntpServers.split(',').join(', ') : t('distroDefault')}</Fact>
          <Fact label={t('resolvers')}>{h?.dnsServers ? h.dnsServers.split(',').join(', ') : h?.resolvers ? h.resolvers.split(',').join(', ') : '–'}</Fact>
        </dl>
      </div>
      {h && <p className="text-xs text-muted">{t('recorded', { when: format.relativeTime(new Date(Math.min(Date.parse(h.checkedAt), now.getTime())), now) })}</p>}

      {manage && <div className="grid gap-4 rounded-2xl border border-border p-4 lg:grid-cols-2">
        <TextInput label={t('hostname')} value={v.hostname} onChange={(x) => setV({ ...v, hostname: x.toLowerCase() })} error={field(fields.hostname)} help={t('hostnameHelp')} spellCheck={false} isDisabled={blocked}/>
        <TimeZonePicker label={t('timezone')} value={v.timezone} onChange={(x) => setV({ ...v, timezone: x })} error={field(fields.timezone)} help={t('timezoneHelp')} isDisabled={blocked}/>
        <TextInput label={t('ntp')} value={v.ntp} onChange={(x) => setV({ ...v, ntp: x })} placeholder="time.cloudflare.com, 0.tr.pool.ntp.org" error={field(fields.ntp)} help={h && !h.timesyncd ? t('noTimesyncd') : t('ntpHelp')} spellCheck={false} isDisabled={blocked}/>
        <TextInput label={t('dns')} value={v.dns} onChange={(x) => setV({ ...v, dns: x })} placeholder="1.1.1.1, 9.9.9.9" error={field(fields.dns)} help={h && !h.resolved ? t('noResolved') : t('dnsHelp')} spellCheck={false} isDisabled={blocked}/>
        <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
          <ConfirmButton label={t('apply')} icon={<I name="check" size={16}/>} variant="primary" isDisabled={blocked || !Object.keys(changed).length} title={t('confirmTitle')}
            body={<ul className="list-disc pl-5 text-sm">{Object.entries(changed).map(([k, x]) => <li key={k}>{t(`change.${k as 'hostname'}`, { value: x })}</li>)}</ul>}
            confirmLabel={t('apply')} cancelLabel={t('cancel')} onConfirm={() => send(changed as Record<string, string>, t('queued'))}/>
          {Object.keys(changed).length > 0 && <span className="text-xs text-muted">{t('pending', { n: Object.keys(changed).length })}</span>}
        </div>
      </div>}

      <AnimatePresence>{st && <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm"><span className="font-medium">{t('lastRun')}</span><StatusChip tone={stateTone[st.state]}>{t(`state.${st.state}`)}</StatusChip>
          {st.code && st.state !== 'running' && st.state !== 'succeeded' && <Chip size="sm" variant="soft">{st.code}</Chip>}</div>
        {d.agent.log.length > 0 && <pre className="max-h-48 overflow-auto rounded-xl bg-default/60 p-3 font-mono text-xs leading-relaxed">{d.agent.log.join('\n')}</pre>}
      </motion.div>}</AnimatePresence>
    </div>
  </Section>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="rounded-xl border border-border px-3 py-2"><dt className="text-xs text-muted">{label}</dt><dd className="mt-0.5 break-words">{children}</dd></div>;
}
