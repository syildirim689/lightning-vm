"use client";
// Extra disks on a server's page: the disks beside the system disk, one more (priced per GB where the location sells
// them, invoiced like a resize), and removing one (its data goes with it).
import { Button, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../components/icon';
import { ConfirmButton, NumberInput, Section, StatusChip } from '../../components/ui';
import { Copy } from './server-extras';
import { apiFetch, type ApiError, useErrorText } from '../../lib/api';
import { useApiQuery } from '../../lib/query';

type Disk = { id: string; sizeGb: number; priceMonthly: string; status: 'pending' | 'ready' | 'removing' | 'failed'; createdAt: string };

export function ServerDisks({ serverId, busy, windows = false }: { serverId: string; busy: boolean; windows?: boolean }) {
  const t = useTranslations('Disks');
  const format = useFormatter();
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<{ disks: Disk[]; pricePerGb: string | null; currency: string; max: number }>(['servers', serverId, 'disks'], `/servers/${serverId}/disks`, { refetchInterval: busy ? 5_000 : false });
  const [size, setSize] = useState<number | undefined>(50);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  useEffect(() => { if (!busy) void q.refetch(); }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!q.data) return null;
  const { disks, pricePerGb, currency, max } = q.data;
  if (pricePerGb === null && !disks.length) return null; // not sold here
  const money = (v: number | string, digits = 2) => format.number(Number(v), { style: 'currency', currency, maximumFractionDigits: digits });
  async function run(path: string, method: string, body: object | undefined, done: string) {
    setSending(true); setFields({});
    try { await apiFetch(path, { method, body }); toast.success(done); client.invalidateQueries({ queryKey: ['servers'] }); client.invalidateQueries({ queryKey: ['tasks'] }); }
    catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setSending(false); }
  }
  const full = disks.filter((d) => d.status !== 'failed').length >= max;
  return <Section title={t('title')} description={t('help')}>
    <div className="flex flex-col gap-4">
      {disks.length === 0 ? <p className="text-sm text-muted">{t('none')}</p>
        : <ul className="flex flex-col divide-y divide-separator rounded-lg border border-border">{disks.map((d) => <li key={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-default text-muted" aria-hidden><I name="hard-drive" size={15}/></span>
          <span className="flex min-w-0 flex-1 flex-col"><span className="font-medium">{d.sizeGb} GB</span><span className="text-xs text-muted">{t('price', { price: money(d.priceMonthly) })}</span></span>
          <StatusChip tone={d.status === 'ready' ? 'success' : d.status === 'failed' ? 'danger' : 'accent'}>{t(`status.${d.status}`)}</StatusChip>
          {(d.status === 'ready' || d.status === 'failed') && <ConfirmButton size="sm" variant="ghost" icon={<I name="trash-2" size={14}/>} label={t('remove')} title={t('removeTitle')} body={t('removeBody')}
            confirmLabel={t('remove')} cancelLabel={t('cancel')} isDisabled={busy} onConfirm={() => run(`/servers/${serverId}/disks/${d.id}`, 'DELETE', undefined, t('removing'))}/>}
        </li>)}</ul>}
      {pricePerGb !== null && !full && <div role="group" aria-label={t('presets')} className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted">{t('presets')}:</span>
        {[50, 100, 250, 500].map((gb) => <button key={gb} type="button" aria-pressed={size === gb} onClick={() => setSize(gb)}
          className={`flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors ${size === gb ? 'border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border hover:border-accent'}`}>
          <span className="font-medium">{gb} GB</span><span className="text-muted">{money((gb * Number(pricePerGb)).toFixed(2))}</span></button>)}
      </div>}
      {pricePerGb === null ? <p className="text-sm text-muted">{t('notSold')}</p> : <div className="flex flex-wrap items-end gap-3">
        <NumberInput className="w-44" label={t('size')} value={size} onChange={setSize} minValue={1} maxValue={16384} step={10} error={field(fields.sizeGb)}
          help={size ? t('price', { price: money((size * Number(pricePerGb)).toFixed(2)) }) : t('perGb', { price: money(pricePerGb, 4) })}/>
        <ConfirmButton variant="primary" icon={<I name="hard-drive" size={15}/>} label={t('add')} isDisabled={busy || full || !size || sending}
          title={t('addTitle', { size: size ?? 0 })} body={t('addBody', { price: money(((size ?? 0) * Number(pricePerGb)).toFixed(2)) })}
          confirmLabel={t('add')} cancelLabel={t('cancel')} onConfirm={() => run(`/servers/${serverId}/disks`, 'POST', { sizeGb: size }, t('added'))}/>
        {full && <p className="w-full text-xs text-muted">{t('full', { max })}</p>}
      </div>}
      {disks.some((d) => d.status === 'ready') && <details className="rounded-lg border border-border px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">{t('howTo')}</summary>
        {windows ? <p className="mt-2 text-muted">{t('howToWindows')}</p>
          : <div className="mt-2 flex flex-col gap-2"><p className="text-muted">{t('howToLinux')}</p>
            <div className="flex items-start gap-2 rounded-lg bg-default px-3 py-2"><pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs">{LINUX}</pre><Copy text={LINUX} label={t('howTo')}/></div></div>}
      </details>}
    </div>
  </Section>;
}

const LINUX = ["lsblk", "sudo mkfs.ext4 /dev/sdb", "sudo mkdir -p /data", "sudo mount /dev/sdb /data", "echo '/dev/sdb /data ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab"].join('\n');
