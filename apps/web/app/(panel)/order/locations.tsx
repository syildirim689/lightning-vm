"use client";
// The order page's location picker: one card per location (flag, city, datacenter, status, IPv6, a latency
// test from the visitor's browser); pools without a location get a card of their own.
import { Button } from '@heroui/react';
import { motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from '../../../components/icon';
import { SelectInput, StatusChip } from '../../../components/ui';
import { flag } from '../../../lib/flag';

export type OrderLocation = { id: string; name: string; city: string; countryCode: string; datacenter: string; description: string; status: 'active' | 'maintenance' | 'hidden';
  pingUrl: string; lookingGlassUrl: string; testIp: string | null };
type Pool = { id: string; name: string; location: string; locationId?: string | null; ipv6: boolean };

// Round-trip time to the location's test URL, from this browser: the best of three (the first warms up DNS/TLS).
async function measure(url: string) {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    try { await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { mode: 'no-cors', cache: 'no-store' }); } catch { return null; }
    best = Math.min(best, performance.now() - t0);
  }
  return Math.round(best);
}

export function LocationPicker({ locations, pools, poolId, onPool }: { locations: OrderLocation[]; pools: Pool[]; poolId: string; onPool: (id: string) => void }) {
  const t = useTranslations('Order.locations');
  const [ping, setPing] = useState<Record<string, number | null | 'busy'>>({});
  const groups = [
    ...locations.map((l) => ({ key: l.id, location: l, pools: pools.filter((p) => p.locationId === l.id) })),
    ...pools.filter((p) => !p.locationId || !locations.some((l) => l.id === p.locationId)).map((p) => ({ key: p.id, location: null, pools: [p] })),
  ].filter((g) => g.pools.length > 0);
  const current = groups.find((g) => g.pools.some((p) => p.id === poolId));
  async function test(l: OrderLocation) {
    setPing((s) => ({ ...s, [l.id]: 'busy' }));
    const ms = await measure(l.pingUrl);
    setPing((s) => ({ ...s, [l.id]: ms }));
  }
  return <div className="flex flex-col gap-3">
    <div role="radiogroup" aria-label={t('label')} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {groups.map((g) => {
        const l = g.location;
        const selected = current?.key === g.key;
        const closed = l?.status === 'maintenance';
        const p = ping[g.key];
        return <motion.div key={g.key} layout className={`relative flex flex-col gap-2 rounded-2xl border p-4 transition-colors ${selected ? 'border-accent bg-accent-soft' : 'border-border'} ${closed ? 'opacity-60' : ''}`}>
          <button type="button" role="radio" aria-checked={selected} disabled={closed} onClick={() => onPool(g.pools[0].id)}
            className="absolute inset-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed" aria-label={l?.name ?? g.pools[0].name}/>
          <div className="pointer-events-none flex items-start gap-3">
            <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-default text-xl">{l && flag(l.countryCode) ? flag(l.countryCode) : <I name="map-pin" size={18}/>}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{l?.name ?? g.pools[0].name}</p>
              <p className="truncate text-xs text-muted">{l ? [l.city, l.countryCode, l.datacenter].filter(Boolean).join(' · ') || '–' : g.pools[0].location || '–'}</p>
            </div>
            {selected && <I name="circle-check" size={18} className="text-accent"/>}
          </div>
          {l?.description && <p className="pointer-events-none line-clamp-2 text-xs text-muted">{l.description}</p>}
          <div className="relative flex flex-wrap items-center gap-1.5">
            {closed && <StatusChip tone="warning">{t('maintenance')}</StatusChip>}
            {g.pools.some((x) => x.ipv6) && <StatusChip tone="default">IPv6</StatusChip>}
            {l?.testIp && <StatusChip tone="default">{t('testIp', { ip: l.testIp })}</StatusChip>}
            {l?.pingUrl && <Button size="sm" variant="ghost" className="relative z-10 h-7 px-2" isDisabled={p === 'busy'} onPress={() => test(l)}>
              <I name="activity" size={13}/>{p === 'busy' ? t('measuring') : typeof p === 'number' ? t('latency', { ms: p }) : p === null ? t('unreachable') : t('measure')}</Button>}
            {l?.lookingGlassUrl && <a href={l.lookingGlassUrl} target="_blank" rel="noreferrer noopener" className="relative z-10 inline-flex items-center gap-1 text-xs text-accent hover:underline">
              {t('lookingGlass')}<I name="external-link" size={11}/></a>}
          </div>
        </motion.div>;
      })}
    </div>
    {current && current.pools.length > 1 && <SelectInput label={t('pool')} value={poolId} onChange={onPool} options={current.pools.map((x) => ({ id: x.id, label: x.name }))}/>}
  </div>;
}
