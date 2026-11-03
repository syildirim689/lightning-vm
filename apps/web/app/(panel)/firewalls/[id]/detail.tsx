"use client";
// One firewall, Hetzner style: inbound and outbound rules edited together and saved at once, then the
// servers it protects with the state of the rules on each (applied / being applied / failed).
import { Button, Chip, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { I } from '../../../../components/icon';
import { CheckboxList, ConfirmButton, DataTable, FormActions, Mono, Notice, PageHeader, Section, SelectInput, StatusChip, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useMe } from '../../../../lib/me';
import { useApiQuery } from '../../../../lib/query';
import { useUnsaved } from '../../../../lib/unsaved';
import { anywhere, covers, hasPort, openDbPorts, protocols, quick, statusTone, type Firewall, type Limits, type Rule } from '../model';

type Detail = Firewall & { limits: Limits };
const ipsText = (ips: string[]) => ips.join(', ');
// The API stores rules as jsonb, which reorders keys: compare values, not JSON text.
const canon = (rs: Rule[]) => JSON.stringify(rs.map((r) => [r.direction, r.protocol, r.port ?? null, r.ips, r.description ?? '']));
const parseIps = (text: string) => text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export default function FirewallDetail({ id }: { id: string }) {
  const t = useTranslations('Firewalls');
  const { error } = useErrorText();
  const router = useRouter();
  const client = useQueryClient();
  const q = useApiQuery<Detail>(['firewalls', id], `/firewalls/${id}`, { refetchInterval: 5_000 });
  const [rename, setRename] = useState(false);
  const [copying, setCopying] = useState(false);
  const me = useMe();
  const gone = (q.error as { code?: string } | null)?.code === 'NOT_FOUND';
  useEffect(() => { if (gone) router.replace('/firewalls'); }, [gone, router]);
  if (!q.data) return <p role="status" className="text-sm text-muted">{q.error && !gone ? error(q.error) : t('loading')}</p>;
  const f = q.data;
  const refresh = () => { client.invalidateQueries({ queryKey: ['firewalls'] }); client.invalidateQueries({ queryKey: ['servers'] }); };
  async function remove() {
    try { await apiFetch(`/firewalls/${id}`, { method: 'DELETE' }); toast.success(t('removed')); refresh(); router.push('/firewalls'); }
    catch (e) { toast.danger(error(e)); throw e; }
  }
  // Same rules under a free name ("x (copy)", "x (copy 2)", ...), no servers; opens the copy.
  async function duplicate() {
    setCopying(true);
    try {
      for (let n = 1; ; n++) {
        const name = (n === 1 ? t('copyName', { name: f.name }) : t('copyNameN', { name: f.name, n })).slice(0, 64);
        try {
          const c = await apiFetch<Firewall>('/firewalls', { method: 'POST', body: { name, rules: f.rules, serverIds: [] } });
          toast.success(t('copied', { name })); refresh(); router.push(`/firewalls/${c.id}`); return;
        } catch (e) { if (n >= 9 || (e as { fields?: Record<string, string> }).fields?.name !== 'NAME_TAKEN') throw e; }
      }
    } catch (e) { toast.danger(error(e)); } finally { setCopying(false); }
  }

  return <div className="flex flex-col gap-6">
    <PageHeader eyebrow={t('title')} title={f.name}
      description={f.ownerEmail}
      actions={<>
        <Button variant="secondary" onPress={() => setRename(true)}><I name="pencil" size={16}/>{t('rename')}</Button>
        {me && f.ownerId === me.id && <Button variant="secondary" isPending={copying} onPress={duplicate}><I name="copy" size={16}/>{t('duplicate')}</Button>}
        <ConfirmButton variant="danger-soft" icon={<I name="trash-2" size={16}/>} label={t('remove')} title={t('removeTitle', { name: f.name })}
          body={f.servers.length ? t('removeInUse', { n: f.servers.length }) : t('removeBody')} confirmLabel={t('remove')} cancelLabel={t('cancel')} onConfirm={remove}/>
      </>}/>
    <Notice title={t('howTitle')}>{t('howBody')}</Notice>
    <RulesEditor firewall={f} onSaved={refresh}/>
    <Servers firewall={f} onChanged={refresh}/>
    {rename && <Rename firewall={f} onClose={() => { setRename(false); refresh(); }}/>}
  </div>;
}

function RulesEditor({ firewall, onSaved }: { firewall: Detail; onSaved: () => void }) {
  const t = useTranslations('Firewalls');
  const { error, field } = useErrorText();
  const [rules, setRules] = useState<Rule[]>(firewall.rules);
  const [ipText, setIpText] = useState<string[]>(firewall.rules.map((r) => ipsText(r.ips)));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const saved = canon(firewall.rules);
  const current = useMemo(() => rules.map((r, i) => ({ ...r, ips: parseIps(ipText[i] ?? '') })), [rules, ipText]);
  const dirty = canon(current) !== saved;
  const me = useMe();
  const myIp = me?.ip?.replace(/^::ffff:/, '');
  // Hints only: the editor still saves whatever the user wants.
  const warnings = useMemo(() => {
    const tcpIn = current.filter((r) => r.direction === 'in' && r.protocol === 'tcp');
    const w: string[] = [];
    if (!tcpIn.some((r) => covers(r.port, 22) || covers(r.port, 3389))) w.push(t('warn.noRemote'));
    for (const [p, name] of openDbPorts(current)) w.push(t('warn.openDb', { port: p, name }));
    const seen = new Set<string>();
    for (const r of current) {
      const k = JSON.stringify([r.direction, r.protocol, r.port ?? '', [...r.ips].sort()]);
      if (seen.has(k)) w.push(t('warn.duplicate', { rule: r.description || `${r.protocol.toUpperCase()} ${r.port ?? ''}`.trim() })); else seen.add(k);
    }
    return w;
  }, [current, t]);
  // Someone else saved meanwhile and this form is untouched: show their version.
  useEffect(() => { if (!dirty) { setRules(firewall.rules); setIpText(firewall.rules.map((r) => ipsText(r.ips))); } }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (i: number, patch: Partial<Rule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = (rule: Rule) => { setRules((rs) => [...rs, rule]); setIpText((x) => [...x, ipsText(rule.ips)]); };
  const removeAt = (i: number) => { setRules((rs) => rs.filter((_, j) => j !== i)); setIpText((x) => x.filter((_, j) => j !== i)); setFields({}); };
  const reset = () => { setRules(firewall.rules); setIpText(firewall.rules.map((r) => ipsText(r.ips))); setFields({}); };
  async function save() {
    setBusy(true); setFields({});
    try { await apiFetch(`/firewalls/${firewall.id}`, { method: 'PUT', body: { rules: current } }); toast.success(t('saved')); onSaved(); }
    catch (e) { setFields((e as { fields?: Record<string, string> }).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  useUnsaved(dirty, () => { if (!busy) void save(); });

  const block = (direction: 'in' | 'out') => {
    const list = rules.map((r, i) => ({ r, i })).filter(({ r }) => r.direction === direction);
    return <Section title={t(direction === 'in' ? 'inbound' : 'outbound')} description={t(direction === 'in' ? 'inboundHelp' : 'outboundHelp')}
      actions={<div className="flex flex-wrap gap-1.5">
        {Object.entries(quick).filter(([k]) => (direction === 'in' ? k !== 'dns' : ['dns', 'http', 'https'].includes(k))).map(([k, r]) => {
          // A shortcut whose rule is already in the list shows a tick instead of adding a duplicate.
          const has = rules.some((x) => x.direction === direction && x.protocol === r.protocol && (x.port ?? '') === (r.port ?? ''));
          return <Button key={k} size="sm" variant="tertiary" isDisabled={has || rules.length >= firewall.limits.rulesPerFirewall} aria-label={has ? t('quickHas', { name: r.description }) : undefined}
            onPress={() => add({ direction, ...r })}><I name={has ? 'check' : 'plus'} size={14}/>{r.description}</Button>;
        })}
        <Button size="sm" variant="secondary" isDisabled={rules.length >= firewall.limits.rulesPerFirewall}
          onPress={() => add({ direction, protocol: 'tcp', port: '', ips: anywhere, description: '' })}><I name="plus" size={14}/>{t('addRule')}</Button>
      </div>}>
      {list.length === 0 ? <p className="rounded-xl border border-dashed border-border py-5 text-center text-sm text-muted">{t(direction === 'in' ? 'noInbound' : 'noOutbound')}</p>
        : <ul className="flex flex-col gap-3">
          <AnimatePresence initial={false}>
            {list.map(({ r, i }) => <motion.li key={i} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}
              className="grid gap-3 rounded-xl border border-border bg-surface p-3 sm:grid-cols-2 lg:grid-cols-[8rem_9rem_minmax(0,1fr)_minmax(0,12rem)_auto] lg:items-start">
              <SelectInput label={t('protocol')} value={r.protocol} onChange={(v) => update(i, { protocol: (v || 'tcp') as Rule['protocol'], port: hasPort((v || 'tcp') as Rule['protocol']) ? (r.port ?? '') : null })}
                options={protocols.map((p) => ({ id: p, label: p.toUpperCase() }))} error={field(fields[`rules.${i}.protocol`])}/>
              <TextInput label={t('port')} value={r.port ?? ''} onChange={(v) => update(i, { port: v })} isDisabled={!hasPort(r.protocol)}
                placeholder={hasPort(r.protocol) ? '443 / 8000-8100' : t('allPorts')} error={field(fields[`rules.${i}.port`])}/>
              <div className="flex flex-col gap-1">
                <TextInput label={t(direction === 'in' ? 'sources' : 'destinations')} value={ipText[i] ?? ''} onChange={(v) => setIpText((x) => x.map((y, j) => (j === i ? v : y)))}
                  error={field(fields[`rules.${i}.ips`])} spellCheck={false} placeholder="0.0.0.0/0, ::/0"/>
                <div className="flex flex-wrap gap-1">
                  <button type="button" className="text-xs text-accent hover:underline" onClick={() => setIpText((x) => x.map((y, j) => (j === i ? ipsText(anywhere) : y)))}>{t('anywhere')}</button>
                  {direction === 'in' && myIp && <button type="button" className="text-xs text-accent hover:underline" onClick={() => setIpText((x) => x.map((y, j) => (j === i ? `${myIp}/${myIp.includes(':') ? 128 : 32}` : y)))}>· {t('myIp', { ip: myIp })}</button>}
                  <span className="text-xs text-muted">· {t('ipsHelp')}</span>
                  {direction === 'in' && <Chip size="sm" variant="soft" color={parseIps(ipText[i] ?? '').some((x) => anywhere.includes(x)) ? 'warning' : 'success'} className="ml-auto">
                    {parseIps(ipText[i] ?? '').some((x) => anywhere.includes(x)) ? t('scopeAll') : t('scopeSome', { n: parseIps(ipText[i] ?? '').length })}</Chip>}
                </div>
              </div>
              <TextInput label={t('description')} value={r.description} onChange={(v) => update(i, { description: v })} maxLength={255}/>
              <Button isIconOnly variant="ghost" aria-label={t('removeRule')} className="lg:mt-6" onPress={() => removeAt(i)}><I name="trash-2" size={16}/></Button>
            </motion.li>)}
          </AnimatePresence>
        </ul>}
    </Section>;
  };

  return <div className="flex flex-col gap-6">
    {block('in')}
    {block('out')}
    {warnings.length > 0 && <Notice tone="warning" title={t('warn.title')}><ul className="list-disc ps-4">{warnings.map((w) => <li key={w}>{w}</li>)}</ul></Notice>}
    <div className="sticky bottom-4 z-30 rounded-2xl border border-border bg-overlay/95 p-3 shadow-lg backdrop-blur">
      <FormActions status={dirty ? <span className="text-warning">{t('unsaved')} <span className="hidden text-muted sm:inline">· {t('saveShortcut')}</span></span> : <span className={rules.length >= firewall.limits.rulesPerFirewall ? 'text-warning' : 'text-muted'}>{t('ruleTotal', { n: rules.length, max: firewall.limits.rulesPerFirewall })}
        {rules.length >= firewall.limits.rulesPerFirewall && <> · {t('ruleLimit')}</>}</span>}>
        <Button variant="tertiary" isDisabled={!dirty || busy} onPress={reset}>{t('discard')}</Button>
        <Button isPending={busy} isDisabled={!dirty} onPress={save}><I name="check" size={16}/>{t('saveRules')}</Button>
      </FormActions>
    </div>
  </div>;
}

function Servers({ firewall, onChanged }: { firewall: Detail; onChanged: () => void }) {
  const t = useTranslations('Firewalls');
  const format = useFormatter();
  const { error } = useErrorText();
  const mine = useApiQuery<{ servers: { id: string; name: string; state: string }[] }>(['servers'], '/servers').data?.servers ?? [];
  const attached = new Set(firewall.servers.map((s) => s.id));
  const candidates = mine.filter((s) => !attached.has(s.id) && !['deleted', 'deleting'].includes(s.state));
  const [pick, setPick] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const call = async (path: string, method: string, body?: object) => {
    setBusy(true);
    try { await apiFetch(path, { method, body }); onChanged(); setPick([]); } catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  };
  const failed = firewall.servers.some((s) => s.status === 'failed');
  return <Section title={t('servers')} description={t('serversHelp', { n: firewall.limits.firewallsPerServer })}
    actions={failed && <Button size="sm" variant="secondary" isPending={busy} onPress={() => call(`/firewalls/${firewall.id}/apply`, 'POST')}><I name="rotate-ccw" size={14}/>{t('reapply')}</Button>}>
    <div className="flex flex-col gap-4">
      <DataTable label={t('servers')} minWidth={560} rows={firewall.servers} rowKey={(s) => s.id} empty={t('noServers')}
        columns={[{ id: 'name', label: t('server') }, { id: 'ip', label: 'IP' }, { id: 'status', label: t('state') }, { id: 'act', label: '' }]}
        cells={(s) => [
          <NextLink key="n" href={`/servers/${s.id}`} className="font-medium hover:underline">{s.name}</NextLink>,
          s.address ? <Mono key="ip">{s.address}</Mono> : '–',
          <div key="s" className="flex flex-col gap-0.5">
            <StatusChip tone={statusTone[s.status]}>{t(`status.${s.status}`)}</StatusChip>
            {s.status === 'failed' && s.errorCode && <span className="text-xs text-danger">{error({ code: s.errorCode })}</span>}
            {s.status === 'applied' && s.appliedAt && <span className="text-xs text-muted">{format.relativeTime(new Date(s.appliedAt))}</span>}
          </div>,
          <Button key="a" size="sm" variant="ghost" isDisabled={busy} onPress={() => call(`/firewalls/${firewall.id}/servers/${s.id}`, 'DELETE')}><I name="unlink" size={14}/>{t('detach')}</Button>,
        ]}/>
      {candidates.length > 0 && <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
        <CheckboxList label={t('applyTo')} value={pick} onChange={setPick} options={candidates.map((s) => ({ id: s.id, label: s.name }))}/>
        <div><Button size="sm" isPending={busy} isDisabled={!pick.length} onPress={() => call(`/firewalls/${firewall.id}/servers`, 'POST', { serverIds: pick })}><I name="link" size={14}/>{t('attach')}</Button></div>
      </div>}
      <p className="flex flex-wrap items-center gap-1 text-xs text-muted"><Chip size="sm" variant="soft">{t('status.pending')}</Chip>{t('pendingHelp')}</p>
    </div>
  </Section>;
}

function Rename({ firewall, onClose }: { firewall: Detail; onClose: () => void }) {
  const t = useTranslations('Firewalls');
  const { error, field } = useErrorText();
  const [name, setName] = useState(firewall.name);
  const [fieldError, setFieldError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await apiFetch(`/firewalls/${firewall.id}`, { method: 'PUT', body: { name } }); toast.success(t('saved')); onClose(); }
    catch (e) { setFieldError((e as { fields?: Record<string, string> }).fields?.name); toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Modal.Backdrop isOpen onOpenChange={(o) => { if (!o) onClose(); }}>
    <Modal.Container size="sm">
      <Modal.Dialog>
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading>{t('rename')}</Modal.Heading></Modal.Header>
        <Modal.Body><TextInput label={t('name')} value={name} onChange={setName} error={field(fieldError)} maxLength={64} isRequired/></Modal.Body>
        <Modal.Footer className="flex justify-end gap-2"><Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button><Button isPending={busy} isDisabled={!name.trim()} onPress={save}>{t('save')}</Button></Modal.Footer>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}
