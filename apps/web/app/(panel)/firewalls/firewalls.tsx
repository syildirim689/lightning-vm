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
import { CheckboxList, Empty, PageHeader, SelectInput, StatusChip, TextInput } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { useMe } from '../../../lib/me';
import { can } from '../../../lib/permissions';
import { useApiQuery } from '../../../lib/query';
import { statusTone, templates, type Firewall, type Limits } from './model';

export default function Firewalls() {
  const t = useTranslations('Firewalls');
  const me = useMe();
  const q = useApiQuery<{ firewalls: Firewall[]; limits: Limits }>(['firewalls'], '/firewalls', { refetchInterval: 10_000 });
  const [creating, setCreating] = useState(false);
  const manage = can(me?.permissions, 'firewalls.manage');
  const list = q.data?.firewalls;

  return <>
    <PageHeader title={t('title')} description={t('intro')} actions={manage && <Button onPress={() => setCreating(true)}><I name="plus" size={16}/>{t('create')}</Button>}/>
    {list && list.length === 0 && <Card><Card.Content><Empty icon={<I name="shield-check" size={28}/>} title={t('emptyTitle')}>{t('emptyBody')}</Empty></Card.Content></Card>}
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {(list ?? []).map((f, i) => {
        const inbound = f.rules.filter((r) => r.direction === 'in').length;
        return <motion.div key={f.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
          <NextLink href={`/firewalls/${f.id}`} className="block h-full rounded-2xl outline-offset-2 transition hover:-translate-y-0.5 hover:shadow-lg">
            <Card className="h-full">
              <Card.Header className="flex flex-row items-start justify-between gap-2">
                <div className="min-w-0">
                  <Card.Title className="truncate text-base font-semibold">{f.name}</Card.Title>
                  <Card.Description className="text-xs text-muted">{t('ruleCount', { in: inbound, out: f.rules.length - inbound })}</Card.Description>
                </div>
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><I name="shield-check" size={18}/></span>
              </Card.Header>
              <Card.Content className="flex flex-wrap gap-1.5">
                {f.servers.length === 0 ? <span className="text-sm text-muted">{t('noServers')}</span>
                  : f.servers.map((s) => <StatusChip key={s.id} tone={statusTone[s.status]}>{s.name} · {t(`status.${s.status}`)}</StatusChip>)}
              </Card.Content>
            </Card>
          </NextLink>
        </motion.div>;
      })}
    </div>
    {creating && q.data && <CreateFirewall limits={q.data.limits} onClose={() => setCreating(false)}/>}
  </>;
}

function CreateFirewall({ limits, onClose }: { limits: Limits; onClose: () => void }) {
  const t = useTranslations('Firewalls');
  const { error, field } = useErrorText();
  const router = useRouter();
  const client = useQueryClient();
  const servers = useApiQuery<{ servers: { id: string; name: string; state: string }[] }>(['servers'], '/servers').data?.servers ?? [];
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('web');
  const [serverIds, setServerIds] = useState<string[]>([]);
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
