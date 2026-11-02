"use client";
// Firewalls list: each card shows its rules at a glance and the servers it protects, with their status.
import { Button, Card, Chip, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../components/icon';
import { CheckboxList, Empty, Notice, PageHeader, SelectInput, Stat, StatusChip, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { useMe } from '../../../lib/me';
import { can } from '../../../lib/permissions';
import { useApiQuery } from '../../../lib/query';
import { openDbPorts, openToAll, statusTone, templates, type Firewall, type Limits } from './model';

export default function Firewalls() {
  const t = useTranslations('Firewalls');
  const me = useMe();
  const q = useApiQuery<{ firewalls: Firewall[]; limits: Limits }>(['firewalls'], '/firewalls', { refetchInterval: 10_000 });
  const [creating, setCreating] = useState<string[] | null>(null);
  const manage = can(me?.permissions, 'firewalls.manage');
  const list = q.data?.firewalls;
  const mine = useApiQuery<{ servers: { id: string; name: string; state: string; firewallCount?: number }[] }>(['servers'], '/servers').data?.servers;
  const unprotected = (mine ?? []).filter((s) => !s.firewallCount && !['deleted', 'deleting'].includes(s.state));
  const attachedAll = (list ?? []).flatMap((f) => f.servers);
  const failed = attachedAll.filter((s) => s.status === 'failed').length;
  const risky = (list ?? []).filter((f) => openDbPorts(f.rules).length).length;
  const [show, setShow] = useState<'failed' | 'risky' | null>(null);
  const toggle = (k: 'failed' | 'risky') => setShow((v) => (v === k ? null : k));
  const shown = (list ?? []).filter((f) => show === 'failed' ? f.servers.some((s) => s.status === 'failed') : show === 'risky' ? openDbPorts(f.rules).length > 0 : true);

  return <div className="flex flex-col gap-4">
    <PageHeader title={t('title')} description={t('intro')} actions={manage && <Button onPress={() => setCreating([])}><I name="plus" size={16}/>{t('create')}</Button>}/>
    {list && list.length > 0 && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label={t('stats.firewalls')} value={list.length} icon={<I name="brick-wall-fire" size={18}/>}/>
      <Stat label={t('stats.protected')} value={new Set(attachedAll.map((s) => s.id)).size} icon={<I name="shield-check" size={18}/>} tone={attachedAll.length ? 'success' : 'default'}
        hint={mine && t('stats.unprotectedHint', { n: unprotected.length })}/>
      <Stat label={t('stats.failed')} value={failed} icon={<I name="circle-x" size={18}/>} tone={failed ? 'danger' : 'default'} pressed={show === 'failed'} onPress={() => toggle('failed')}/>
      <Stat label={t('stats.risky')} value={risky} icon={<I name="shield-alert" size={18}/>} tone={risky ? 'warning' : 'default'} pressed={show === 'risky'} onPress={() => toggle('risky')}/>
    </div>}
    {manage && unprotected.length > 0 && <Notice tone="warning" title={t('unprotectedTitle', { n: unprotected.length })}>
      <div className="flex flex-col gap-2">
        <p>{t('unprotectedBody')}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {unprotected.slice(0, 6).map((s) => <NextLink key={s.id} href={`/servers/${s.id}`} className="rounded-md border border-border px-2 py-0.5 text-xs font-medium hover:border-accent">{s.name}</NextLink>)}
          {unprotected.length > 6 && <span className="text-xs text-muted">+{unprotected.length - 6}</span>}
        </div>
        <div><Button size="sm" onPress={() => setCreating(unprotected.map((s) => s.id))}><I name="shield-plus" size={14}/>{t('protectAll')}</Button></div>
      </div>
    </Notice>}
    {list && list.length === 0 && <Card><Card.Content><Empty icon={<I name="shield-check" size={28}/>} title={t('emptyTitle')}>{t('emptyBody')}</Empty></Card.Content></Card>}
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {show && shown.length === 0 && <p className="col-span-full rounded-xl border border-dashed border-border py-6 text-center text-sm text-muted">{t('noneMatch')}
        {' '}<button type="button" className="text-accent hover:underline" onClick={() => setShow(null)}>{t('showAll')}</button></p>}
      {shown.map((f, i) => {
        const inRules = f.rules.filter((r) => r.direction === 'in');
        const inbound = inRules.length;
        const risks = openDbPorts(f.rules);
        return <motion.div key={f.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
          <NextLink href={`/firewalls/${f.id}`} className="block h-full rounded-2xl outline-offset-2 transition hover:-translate-y-0.5 hover:shadow-lg">
            <Card className="h-full">
              <Card.Header className="flex flex-row items-start justify-between gap-2">
                <div className="min-w-0">
                  <Card.Title className="truncate text-base font-semibold">{f.name}</Card.Title>
                  <Card.Description className="text-xs text-muted">{t('ruleCount', { in: inbound, out: f.rules.length - inbound })}</Card.Description>
                </div>
                <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${risks.length ? 'bg-warning/15 text-warning' : 'bg-accent-soft text-accent'}`}
                  title={risks.length ? t('riskShort', { ports: risks.map(([p]) => p).join(', ') }) : undefined}>
                  <I name={risks.length ? 'shield-alert' : 'shield-check'} size={18}/></span>
              </Card.Header>
              {inbound > 0 && <div className="flex flex-wrap gap-1" aria-label={t('inbound')}>
                {inRules.slice(0, 6).map((r, j) => <span key={j} title={r.ips.join(', ')}
                  className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${openToAll(r) ? 'border-border' : 'border-success/40 text-success'}`}>
                  {!openToAll(r) && <I name="lock" size={11}/>}{r.description || r.protocol.toUpperCase()}
                  {r.port && <span className="font-mono text-muted">{r.port}</span>}</span>)}
                {inbound > 6 && <span className="px-1 py-0.5 text-[11px] text-muted">+{inbound - 6}</span>}
              </div>}
              {risks.length > 0 && <p className="flex items-center gap-1.5 text-xs text-warning"><I name="triangle-alert" size={13}/>{t('riskShort', { ports: risks.map(([p, n]) => `${p} ${n}`).join(', ') })}</p>}
              <Card.Content className="flex flex-wrap gap-1.5">
                {f.servers.length === 0 ? <span className="text-sm text-muted">{t('noServers')}</span>
                  : f.servers.map((s) => <StatusChip key={s.id} tone={statusTone[s.status]}>{s.name} · {t(`status.${s.status}`)}</StatusChip>)}
              </Card.Content>
            </Card>
          </NextLink>
        </motion.div>;
      })}
    </div>
    {creating && q.data && <CreateFirewall limits={q.data.limits} initialServers={creating} onClose={() => setCreating(null)}/>}
  </div>;
}

function CreateFirewall({ limits, initialServers, onClose }: { limits: Limits; initialServers: string[]; onClose: () => void }) {
  const t = useTranslations('Firewalls');
  const { error, field } = useErrorText();
  const router = useRouter();
  const client = useQueryClient();
  const servers = useApiQuery<{ servers: { id: string; name: string; state: string }[] }>(['servers'], '/servers').data?.servers ?? [];
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('web');
  const [serverIds, setServerIds] = useState<string[]>(initialServers);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setFields({});
    try {
      const f = await apiFetch<Firewall>('/firewalls', { method: 'POST', body: { name, rules: templates[template], serverIds } });
      toast.success(t('created')); client.invalidateQueries({ queryKey: ['firewalls'] }); router.push(`/firewalls/${f.id}`);
    } catch (e) { setFields((e as { fields?: Record<string, string> }).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Modal.Backdrop isOpen onOpenChange={(o) => { if (!o) onClose(); }}>
    <Modal.Container size="md">
      <Modal.Dialog>
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading>{t('create')}</Modal.Heading></Modal.Header>
        <Modal.Body className="flex flex-col gap-4">
          <TextInput label={t('name')} value={name} onChange={setName} error={field(fields.name)} isRequired maxLength={64} placeholder="web-firewall"/>
          <SelectInput label={t('template')} value={template} onChange={(v) => setTemplate(v || 'empty')} help={t('templateHelp')}
            options={Object.keys(templates).map((k) => ({ id: k, label: t(`templates.${k as 'web'}`), description: t(`templateDesc.${k as 'web'}`) }))}/>
          <div className="flex flex-wrap gap-1.5">{templates[template].map((r) => <Chip key={r.description} size="sm" variant="soft">{r.description}</Chip>)}</div>
          {servers.filter((s) => s.state !== 'deleted').length > 0 && <CheckboxList label={t('applyTo')} value={serverIds} onChange={setServerIds} error={field(fields.serverIds)}
            help={t('applyHelp', { n: limits.firewallsPerServer })} options={servers.filter((s) => s.state !== 'deleted').map((s) => ({ id: s.id, label: s.name }))}/>}
        </Modal.Body>
        <Modal.Footer className="flex justify-end gap-2"><Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button><Button isPending={busy} isDisabled={!name.trim()} onPress={save}>{t('create')}</Button></Modal.Footer>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}
