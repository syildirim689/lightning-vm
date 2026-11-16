"use client";
// "Can I reach it?": the usual reasons a server cannot be reached, checked from what the panel already knows —
// power, the VM's network cards, the address the guest really uses, its gateway and the firewall rules for the
// login port (SSH 22, or RDP 3389 on Windows). Each failed check says what to do next. Nothing is changed here.
import { Button, toast } from '@heroui/react';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { I } from '../../components/icon';
import { Section } from '../../components/ui';
import { useApiQuery } from '../../lib/query';
import { allows, bare, guestAgent, loginPort, usesAddress } from '../../lib/connect';
import type { Platformed } from '../../components/capabilities';
import type { Rule } from './firewalls/model';
import { ToolsHint, type VmDetailsData } from './vm-details';

export type CheckState = 'ok' | 'warn' | 'fail' | 'unknown';
export type Check = { key: string; state: CheckState; text: string; href?: string; link?: string; extra?: React.ReactNode };
type Target = { id: string; state: string; powerState: string; address: string | null; imageName: string; firewallStatus?: 'applied' | 'pending' | 'failed' } & Platformed;

const icon = { ok: <I name="circle-check" size={18} className="text-success"/>, warn: <I name="triangle-alert" size={18} className="text-warning"/>,
  fail: <I name="circle-x" size={18} className="text-danger"/>, unknown: <I name="circle-help" size={18} className="text-muted"/> };

export function ConnectCheck({ server: s }: { server: Target }) {
  const t = useTranslations('ConnectCheck');
  const live = s.state === 'ready' || s.state === 'error';
  // The same queries as the firewall and details sections, so no extra requests.
  const fw = useApiQuery<{ firewalls: { id: string; name: string; rules: Rule[] }[] }>(['firewalls', 'server', s.id], `/firewalls?serverId=${s.id}`).data?.firewalls;
  const d = useApiQuery<VmDetailsData>(['vm-details', s.id], live ? `/servers/${s.id}/details` : null).data;
  if (!live) return null;

  const os = d?.guest.os || d?.configuredOs || s.imageName;
  const port = loginPort(`${os} ${d?.guest.family ?? ''}`);
  const service = port === 3389 ? 'RDP' : 'SSH';
  const checks: Check[] = [];
  const on = s.powerState === 'poweredOn';
  checks.push(on ? { key: 'power', state: 'ok', text: t('power.ok') } : { key: 'power', state: 'fail', text: t('power.fail') });
  if (!d) checks.push({ key: 'vm', state: 'unknown', text: t('vm.loading') });
  else {
    const down = d.nics.filter((n) => !n.connected);
    checks.push(d.nics.length === 0 ? { key: 'nic', state: 'fail', text: t('nic.none') }
      : down.length && on ? { key: 'nic', state: 'fail', text: t('nic.fail', { nics: down.map((n) => n.label).join(', ') }) }
      : { key: 'nic', state: 'ok', text: t('nic.ok', { n: d.nics.length }) });
    const guestIps = bare(d.guest.ips);
    if (!on) { /* nothing to read from a stopped guest */ }
    else if (!guestIps.length) checks.push({ key: 'guest', state: 'unknown', text: d.tools.runningStatus === 'guestToolsRunning' ? t('guest.noIp') : t('guest.noTools'),
      extra: d.tools.runningStatus === 'guestToolsRunning' ? undefined : <ToolsHint os={`${d.guest.os || d.configuredOs} ${d.guestId} ${s.imageName}`} platform={s.platform}/> });
    else if (!usesAddress(guestIps, s.address)) checks.push({ key: 'guest', state: 'fail', text: t('guest.mismatch', { expected: s.address ?? '', actual: guestIps.join(', ') }) });
    else checks.push({ key: 'guest', state: 'ok', text: t('guest.ok', { address: s.address ?? guestIps[0] }) });
    // No gateway reported: a fault only where the platform really reads it from the guest (VMware). Elsewhere, or
    // while the platform is not known, it only means "could not be read".
    if (on && guestIps.length) checks.push(d.guest.gateways.length ? { key: 'gateway', state: 'ok', text: t('gateway.ok', { gateway: d.guest.gateways.join(', ') }) }
      : guestAgent(s.platform) === 'vmware' ? { key: 'gateway', state: 'warn', text: t('gateway.none') } : { key: 'gateway', state: 'unknown', text: t('gateway.unknown') });
  }
  if (!s.address) checks.push({ key: 'address', state: 'fail', text: t('address.none') });
  if (!fw) checks.push({ key: 'firewall', state: 'unknown', text: t('firewall.loading') });
  else if (!fw.length) checks.push({ key: 'firewall', state: 'ok', text: t('firewall.none') });
  else if (s.firewallStatus === 'failed') checks.push({ key: 'firewall', state: 'fail', text: t('firewall.failed'), href: '/firewalls', link: t('firewall.open') });
  else {
    const open = fw.find((f) => allows(f.rules, port));
    checks.push(open ? { key: 'firewall', state: s.firewallStatus === 'pending' ? 'warn' : 'ok', text: t(s.firewallStatus === 'pending' ? 'firewall.pending' : 'firewall.ok', { service, port, name: open.name }) }
      : { key: 'firewall', state: 'fail', text: t('firewall.closed', { service, port }), href: `/firewalls/${fw[0].id}`, link: t('firewall.fix', { name: fw[0].name }) });
  }

  const problems = checks.filter((c) => c.state === 'fail' || c.state === 'warn').length;
  const pending = checks.some((c) => c.state === 'unknown' && c.key !== 'guest' && c.key !== 'gateway');
  const summary = problems ? t('summary.problems', { n: problems }) : pending ? t('summary.checking') : t('summary.ok', { service });
  const asText = () => [`${t('title')}: ${summary}`, ...checks.map((c) => `[${t(`state.${c.state}`)}] ${c.text}`)].join('\n');

  return <Section title={t('title')} description={t('help', { service, port })}
    actions={<Button size="sm" variant="ghost" onPress={async () => { await navigator.clipboard?.writeText(asText()).catch(() => undefined); toast.success(t('copied')); }}>
      <I name="clipboard-copy" size={15}/>{t('copy')}</Button>}>
    <div className="flex flex-col gap-3">
      <p role="status" className={`flex items-center gap-2 text-sm font-medium ${problems ? 'text-danger' : ''}`}>{problems ? icon.fail : pending ? icon.unknown : icon.ok}{summary}</p>
      <ul aria-label={t('title')} className="flex flex-col divide-y divide-separator rounded-xl border border-border">
        {checks.map((c) => <li key={c.key} className="flex items-start gap-3 px-3 py-2.5 text-sm">
          <span aria-hidden className="mt-0.5 shrink-0">{icon[c.state]}</span>
          <span className="flex min-w-0 flex-1 flex-col gap-2 break-words"><span><span className="sr-only">{t(`state.${c.state}`)}: </span>{c.text}</span>{c.extra}</span>
          {c.href && <NextLink href={c.href} className="shrink-0 font-medium text-accent hover:underline">{c.link}</NextLink>}
        </li>)}
      </ul>
    </div>
  </Section>;
}
