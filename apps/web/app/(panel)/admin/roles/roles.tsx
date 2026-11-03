"use client";
// Roles: named permission sets. Built-in ones can be edited (except Administrator, which always has
// everything); custom ones can be added and removed. Users get roles on the Users page.
import { Button, Card, Checkbox, Chip, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../../components/icon';
import { ConfirmButton, Notice, PageHeader, TextInput, CheckboxInput } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useMe } from '../../../../lib/me';
import { can } from '../../../../lib/permissions';
import { useApiQuery } from '../../../../lib/query';

type Limits = { maxServers?: number; maxVcpu?: number; maxMemoryMb?: number; maxDiskGb?: number; maxSnapshots?: number; maxFirewalls?: number; maxSshKeys?: number;
  operationsPerHour?: number; sessionHours?: number; require2fa?: boolean; allowedLocations?: string[]; allowedIps?: string[] };
type Role = { key: string; name: string; description: string; permissions: string[]; builtin: boolean; members: number; limits: Limits };
// Number limits in the editor, grouped; memory is entered in GB and stored in MB.
const numberLimits = [
  ['quota', ['maxServers', 'maxVcpu', 'maxMemoryMb', 'maxDiskGb']],
  ['counts', ['maxSnapshots', 'maxFirewalls', 'maxSshKeys', 'operationsPerHour']],
  ['session', ['sessionHours']],
] as const;
type NumberLimit = (typeof numberLimits)[number][1][number];

export default function Roles() {
  const t = useTranslations('Roles');
  const tp = useTranslations('Permissions');
  const { error } = useErrorText();
  const client = useQueryClient();
  const me = useMe();
  const manage = can(me?.permissions, 'roles.manage');
  const roles = useApiQuery<{ roles: Role[] }>(['admin', 'roles'], '/admin/roles').data?.roles;
  const groups = useApiQuery<{ groups: Record<string, string[]> }>(['admin', 'permissions'], '/admin/permissions').data?.groups;
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [copyOf, setCopyOf] = useState<Role | null>(null);
  const total = Object.values(groups ?? {}).flat().length;
  const remove = async (key: string) => { await apiFetch(`/admin/roles/${key}`, { method: 'DELETE' }).catch((e) => { toast.danger(error(e)); throw e; }); toast.success(t('removed')); client.invalidateQueries({ queryKey: ['admin', 'roles'] }); };

  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')} actions={manage && <Button onPress={() => { setCopyOf(null); setEditing('new'); }}><I name="plus" size={16}/>{t('new')}</Button>}/>
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {(roles ?? []).map((r, i) => <motion.div key={r.key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
        <Card className="h-full">
          <Card.Header className="flex flex-row items-start justify-between gap-2">
            <div className="min-w-0">
              <Card.Title className="flex items-center gap-2 text-base font-semibold">{t.has(`builtinName.${r.key}` as 'builtinName.admin') ? t(`builtinName.${r.key}` as 'builtinName.admin') : r.name}{r.builtin && <Chip size="sm" variant="soft">{t('builtin')}</Chip>}</Card.Title>
              <Card.Description className="text-xs text-muted"><code>{r.key}</code> · <NextLink href={`/admin/users?role=${r.key}`} className="hover:text-accent hover:underline">{t('members', { n: r.members })}</NextLink>
                {total > 0 && !r.permissions.includes('*') && <> · {t('permCount', { n: r.permissions.length, total })}</>}</Card.Description>
            </div>
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><I name="shield-check" size={18}/></span>
          </Card.Header>
          <Card.Content className="flex flex-1 flex-col gap-3">
            <p className="text-sm text-muted">{t.has(`desc.${r.key}` as 'desc.admin') ? t(`desc.${r.key}` as 'desc.admin') : r.description || t('noDescription')}</p>
            <div className="flex flex-wrap gap-1">
              {r.permissions.includes('*') ? <Chip size="sm" color="accent" variant="soft">{t('everything')}</Chip>
                : r.permissions.length === 0 ? <span className="text-xs text-muted">{t('nothing')}</span>
                : r.permissions.map((p) => <Chip key={p} size="sm" variant="secondary">{tp(`p.${p.replace('.', '_')}` as 'p.servers_create')}</Chip>)}
            </div>
            {Object.keys(r.limits ?? {}).length > 0 && <div className="flex flex-wrap gap-1 border-t border-separator pt-3">
              <span className="mr-1 inline-flex items-center gap-1 text-xs font-medium text-muted"><I name="gauge" size={13}/>{t('limits.title')}:</span>
              {Object.entries(r.limits).map(([k, v]) => <Chip key={k} size="sm" variant="soft" color="warning">
                {k === 'require2fa' ? t('limits.require2faShort') : Array.isArray(v) ? t('limits.listShort', { name: t(`limits.${k}` as 'limits.allowedIps'), n: v.length })
                  : `${t(`limits.${k}` as 'limits.maxServers')}: ${k === 'maxMemoryMb' ? `${Number(v) / 1024} GB` : v}`}</Chip>)}
            </div>}
          </Card.Content>
          {manage && <Card.Footer className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" aria-label={t('duplicateOne', { name: r.name })} onPress={() => { setCopyOf(r); setEditing('new'); }}><I name="copy" size={15}/>{t('duplicate')}</Button>
            {r.key !== 'admin' && <>
            {r.key !== 'user' && <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={15}/>} label={t('remove')} title={t('removeTitle', { name: r.name })}
              body={t('removeBody', { n: r.members })} confirmLabel={t('remove')} cancelLabel={t('cancel')} onConfirm={() => remove(r.key)}/>}
            <Button size="sm" variant="secondary" onPress={() => setEditing(r)}><I name="pencil" size={15}/>{t('edit')}</Button></>}
          </Card.Footer>}
        </Card>
      </motion.div>)}
    </div>
    {editing && groups && <RoleEditor role={editing === 'new' ? null : editing} from={editing === 'new' ? copyOf : null} groups={groups} mine={me?.permissions ?? []} onClose={() => setEditing(null)}/>}
  </>;
}

// `from` starts a new role as a copy of another (its permissions and limits), keeping only what you may grant.
function RoleEditor({ role, from, groups, mine, onClose }: { role: Role | null; from?: Role | null; groups: Record<string, string[]>; mine: string[]; onClose: () => void }) {
  const t = useTranslations('Roles');
  const tp = useTranslations('Permissions');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  // Permissions you do not hold cannot be granted (the API refuses them too).
  const grantable = (p: string) => mine.includes('*') || mine.includes(p);
  const base = role ?? from;
  const copyName = from ? t('copyName', { name: from.name }) : '';
  const [v, setV] = useState({ key: role?.key ?? (from ? copyName.toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) : ''), name: role?.name ?? copyName,
    description: base?.description ?? '', permissions: role?.permissions ?? (from ? (from.permissions.includes('*') ? Object.values(groups).flat() : from.permissions).filter(grantable) : []) });
  const l0 = base?.limits ?? {};
  // Kept as text while editing: empty means "no limit".
  const [lim, setLim] = useState<Record<NumberLimit, string>>(() => Object.fromEntries(numberLimits.flatMap(([, ks]) => ks).map((k) =>
    [k, l0[k] === undefined ? '' : String(k === 'maxMemoryMb' ? l0[k]! / 1024 : l0[k])])) as Record<NumberLimit, string>);
  const [require2fa, setRequire2fa] = useState(!!l0.require2fa);
  const [locs, setLocs] = useState<string[]>(l0.allowedLocations ?? []);
  const [ips, setIps] = useState((l0.allowedIps ?? []).join('\n'));
  const locations = useApiQuery<{ locations: { id: string; name: string; countryCode: string }[] }>(['admin', 'locations'], '/admin/locations').data?.locations;
  const limits = () => ({ ...Object.fromEntries(Object.entries(lim).filter(([, x]) => x.trim() !== '').map(([k, x]) => [k, k === 'maxMemoryMb' ? Math.round(Number(x) * 1024) : Number(x)])),
    require2fa, allowedLocations: locs, allowedIps: ips.split(/[\s,]+/).filter(Boolean) });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toggle = (p: string, on: boolean) => setV((x) => ({ ...x, permissions: on ? [...x.permissions, p] : x.permissions.filter((y) => y !== p) }));
  async function save() {
    setBusy(true); setFields({});
    try {
      await apiFetch(role ? `/admin/roles/${role.key}` : '/admin/roles', { method: role ? 'PUT' : 'POST', body: { ...v, limits: limits() } });
      toast.success(t('saved')); client.invalidateQueries({ queryKey: ['admin', 'roles'] }); onClose();
    } catch (e) { setFields((e as { fields?: Record<string, string> }).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  return <Modal.Backdrop isOpen onOpenChange={(o) => { if (!o) onClose(); }}>
    <Modal.Container size="lg" scroll="inside">
      <Modal.Dialog>
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading>{role ? t('editTitle', { name: role.name }) : t('new')}</Modal.Heading></Modal.Header>
        <Modal.Body className="flex flex-col gap-5">
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">{t('identity')}</legend>
            <TextInput label={t('name')} value={v.name} onChange={(name) => setV((x) => ({ ...x, name, key: role ? x.key : name.toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) }))} error={field(fields.name)} isRequired/>
            <TextInput label={t('key')} value={v.key} onChange={(key) => setV((x) => ({ ...x, key }))} isDisabled={!!role} error={field(fields.key)} help={t('keyHelp')} spellCheck={false}/>
            <TextInput className="sm:col-span-2" label={t('description')} value={v.description} onChange={(description) => setV((x) => ({ ...x, description }))} maxLength={300}/>
          </fieldset>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-semibold">{t('permissions')} <span className="font-normal text-muted">· {t('selected', { n: v.permissions.length })}</span></legend>
            <div className="grid gap-3 md:grid-cols-2">
              {Object.entries(groups).map(([g, list]) => <div key={g} className="rounded-xl border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted">{tp(`group.${g}` as 'group.servers')}</p>
                  <button type="button" className="text-xs text-accent hover:underline" onClick={() => {
                    const all = list.filter(grantable).every((p) => v.permissions.includes(p));
                    setV((x) => ({ ...x, permissions: all ? x.permissions.filter((p) => !list.includes(p)) : [...new Set([...x.permissions, ...list.filter(grantable)])] }));
                  }}>{t('toggleGroup')}</button>
                </div>
                <ul className="flex flex-col gap-2">{list.map((p) => <li key={p}>
                  <Checkbox isSelected={v.permissions.includes(p)} onChange={(on) => toggle(p, on)} isDisabled={!grantable(p)}>
                    <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>
                      <span className="flex flex-col"><span className="text-sm">{tp(`p.${p.replace('.', '_')}` as 'p.servers_create')}</span>
                        <span className="text-xs text-muted">{tp(`help.${p.replace('.', '_')}` as 'help.servers_create')}</span></span>
                    </Checkbox.Content>
                  </Checkbox>
                </li>)}</ul>
              </div>)}
            </div>
            {fields.permissions && <Notice tone="danger">{field(fields.permissions)}</Notice>}
          </fieldset>
          {role?.key !== 'admin' && <fieldset className="flex flex-col gap-4">
            <legend className="mb-1 text-sm font-semibold">{t('limits.title')} <span className="font-normal text-muted">· {t('limits.intro')}</span></legend>
            {numberLimits.map(([group, keys]) => <div key={group} className="rounded-xl border border-border p-3">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">{t(`limits.group.${group}`)}</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {keys.map((k) => <TextInput key={k} type="number" label={t(`limits.${k}`)} value={lim[k]} onChange={(x) => setLim((s) => ({ ...s, [k]: x }))}
                  placeholder={t('limits.unlimited')} help={t(`limits.help.${k}`)} error={field(fields[`limits.${k}`])}/>)}
              </div>
            </div>)}
            <div className="rounded-xl border border-border p-3">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">{t('limits.group.access')}</p>
              <div className="flex flex-col gap-4">
                <CheckboxInput label={t('limits.require2fa')} help={t('limits.help.require2fa')} isSelected={require2fa} onChange={setRequire2fa}/>
                {locations && locations.length > 0 && <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">{t('limits.allowedLocations')}</p>
                  <p className="text-xs text-muted">{t('limits.help.allowedLocations')}</p>
                  <div className="flex flex-wrap gap-2">{locations.map((x) => <button key={x.id} type="button" role="checkbox" aria-checked={locs.includes(x.id)}
                    onClick={() => setLocs((s) => (s.includes(x.id) ? s.filter((y) => y !== x.id) : [...s, x.id]))}
                    className={`rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent ${locs.includes(x.id) ? 'border-accent bg-accent/10 text-accent' : 'border-border hover:border-accent/50'}`}>{x.name}</button>)}</div>
                  {fields['limits.allowedLocations'] && <p className="text-xs text-danger">{field(fields['limits.allowedLocations'])}</p>}
                </div>}
                <TextInput multiline label={t('limits.allowedIps')} value={ips} onChange={setIps} placeholder={'203.0.113.0/24\n2001:db8::/32'} help={t('limits.help.allowedIps')}
                  error={field(fields['limits.allowedIps'])} spellCheck={false}/>
              </div>
            </div>
          </fieldset>}
        </Modal.Body>
        <Modal.Footer className="flex justify-end gap-2"><Button variant="tertiary" onPress={onClose}>{t('cancel')}</Button><Button isPending={busy} onPress={save}>{t('save')}</Button></Modal.Footer>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}
