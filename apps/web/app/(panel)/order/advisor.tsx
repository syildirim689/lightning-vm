"use client";
// "What will you run?": a workload and the expected traffic give a starting size; the cheapest package that meets
// it is marked "Recommended" (or, for a custom server, the values can be applied). Optional and dismissable.
import { Button } from '@heroui/react';
import { AnimatePresence, motion } from 'motion/react';
import { useFormatter, useTranslations } from 'next-intl';
import { I } from '../../../components/icon';
import { workloads, type Shape, type Traffic, type Workload } from '../../../lib/sizing';

const icons: Record<Workload, string> = { website: 'globe', ecommerce: 'shopping-cart', database: 'database', app: 'code', containers: 'container', game: 'gamepad-2', mail: 'mail', dev: 'flask-conical' };

export function WorkloadAdvisor({ want, onWant, need, recommended, enough, onApply, applyLabel }: {
  want: { w: Workload; traffic: Traffic } | null; onWant: (v: { w: Workload; traffic: Traffic } | null) => void; need: Shape | null;
  recommended: string | null; enough: boolean; onApply: () => void; applyLabel: string;
}) {
  const t = useTranslations('Order.advisor');
  const format = useFormatter();
  return <div className="mb-5 rounded-2xl border border-border bg-default/30 p-4">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p className="flex items-center gap-2 text-sm font-semibold"><I name="wand-sparkles" size={16} className="text-accent"/>{t('title')}</p>
      {want && <button type="button" onClick={() => onWant(null)} className="text-xs text-muted hover:text-foreground hover:underline">{t('clear')}</button>}
    </div>
    <div role="radiogroup" aria-label={t('title')} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {(Object.keys(workloads) as Workload[]).map((w) => <button key={w} type="button" role="radio" aria-checked={want?.w === w}
        onClick={() => onWant({ w, traffic: want?.traffic ?? 'low' })}
        className={`flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent ${want?.w === w ? 'border-accent bg-accent/10 font-medium' : 'border-border bg-surface hover:border-accent/50'}`}>
        <I name={icons[w]} size={16} className={want?.w === w ? 'text-accent' : 'text-muted'}/>{t(`w.${w}`)}</button>)}
    </div>
    <AnimatePresence initial={false}>
      {want && need && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
        <div className="mt-4 flex flex-col gap-3">
          <div role="radiogroup" aria-label={t('traffic')} className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted">{t('traffic')}</span>
            {(['low', 'medium', 'high'] as const).map((x) => <button key={x} type="button" role="radio" aria-checked={want.traffic === x} onClick={() => onWant({ ...want, traffic: x })}
              className={`min-h-9 rounded-full border px-3 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-accent ${want.traffic === x ? 'border-accent bg-accent text-accent-foreground' : 'border-border bg-surface hover:border-accent/50'}`}>{t(`t.${x}`)}</button>)}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface p-3">
            <p className="text-sm">{t('needs', { vcpu: need.vcpu, memory: format.number(need.memoryMb / 1024), disk: need.diskGb })}
              <span className={`mt-0.5 block text-xs ${enough ? 'text-muted' : 'text-warning'}`}>{recommended ? (enough ? t('recommendedHint') : t('notEnough')) : t('noPackage')}</span></p>
            {(recommended || applyLabel) && <Button size="sm" onPress={onApply}><I name="check" size={14}/>{applyLabel}</Button>}
          </div>
        </div>
      </motion.div>}
    </AnimatePresence>
  </div>;
}
