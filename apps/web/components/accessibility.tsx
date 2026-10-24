"use client";
// Accessibility: the header button opening the preferences, the preferences themselves (also on the account
// page), and the runtime part (applies them to <html>, the reading guide).
import { Button, Modal, Tooltip } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { applyA11y, useA11y, type A11y } from '../lib/a11y';
import { I } from './icon';

type Option<K extends keyof A11y> = { key: K; icon: React.ReactNode; values: A11y[K][] };
const groups: { title: 'reading' | 'motion' | 'navigation'; options: Option<keyof A11y>[] }[] = [
  { title: 'reading', options: [
    { key: 'text', icon: <I name="a-large-small" size={18} className="mt-0.5 shrink-0 text-accent"/>, values: ['100', '112', '125', '150'] },
    { key: 'contrast', icon: <I name="contrast" size={18} className="mt-0.5 shrink-0 text-accent"/>, values: ['normal', 'high'] },
    { key: 'font', icon: <I name="type" size={18} className="mt-0.5 shrink-0 text-accent"/>, values: ['default', 'legible'] },
    { key: 'spacing', icon: <I name="text" size={18} className="mt-0.5 shrink-0 text-accent"/>, values: ['normal', 'wide'] },
  ] as Option<keyof A11y>[] },
  { title: 'motion', options: [
    { key: 'motion', icon: <I name="pause" size={18} className="mt-0.5 shrink-0 text-accent"/>, values: ['system', 'reduce', 'allow'] },
    { key: 'transparency', icon: <I name="layers" size={18} className="mt-0.5 shrink-0 text-accent"/>, values: ['normal', 'reduce'] },
  ] as Option<keyof A11y>[] },
  { title: 'navigation', options: [
    { key: 'links', icon: <I name="underline" size={18} className="mt-0.5 shrink-0 text-accent"/>, values: ['normal', 'underline'] },
    { key: 'focus', icon: <I name="scan" size={18} className="mt-0.5 shrink-0 text-accent"/>, values: ['normal', 'strong'] },
    { key: 'targets', icon: <I name="pointer" size={18} className="mt-0.5 shrink-0 text-accent"/>, values: ['normal', 'large'] },
    { key: 'cursor', icon: <I name="mouse-pointer-2" size={18} className="mt-0.5 shrink-0 text-accent"/>, values: ['normal', 'large'] },
    { key: 'guide', icon: <I name="ruler" size={18} className="mt-0.5 shrink-0 text-accent"/>, values: ['off', 'on'] },
  ] as Option<keyof A11y>[] },
];

export function AccessibilitySettings() {
  const t = useTranslations('A11y');
  const prefs = useA11y();
  const changed = groups.some((g) => g.options.some((o) => prefs[o.key] !== o.values[0]));
  return <div className="flex flex-col gap-6">
    <p className="text-sm text-muted">{t('intro')}</p>
    {groups.map((g) => <section key={g.title} className="flex flex-col gap-3" aria-labelledby={`a11y-${g.title}`}>
      <h3 id={`a11y-${g.title}`} className="text-sm font-semibold">{t(`groups.${g.title}`)}</h3>
      {g.options.map((o) => <div key={o.key} className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          {o.icon}
          <div><p id={`a11y-l-${o.key}`} className="text-sm font-medium">{t(`${o.key}.label` as 'text.label')}</p><p className="text-xs text-muted">{t(`${o.key}.help` as 'text.help')}</p></div>
        </div>
        <div role="radiogroup" aria-labelledby={`a11y-l-${o.key}`} className="flex shrink-0 flex-wrap gap-1 rounded-xl bg-default p-1">
          {o.values.map((v) => <button key={v} type="button" role="radio" aria-checked={prefs[o.key] === v} onClick={() => prefs.set({ [o.key]: v })}
            className={`min-h-9 rounded-lg px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${prefs[o.key] === v ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-foreground'}`}>
            {t(`${o.key}.${v}` as 'text.100')}
          </button>)}
        </div>
      </div>)}
    </section>)}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-separator pt-4">
      <p className="text-xs text-muted">{t('stored')}</p>
      <Button variant="secondary" size="sm" isDisabled={!changed} onPress={prefs.reset}><I name="rotate-ccw" size={14}/>{t('reset')}</Button>
    </div>
  </div>;
}

export function AccessibilityButton() {
  const t = useTranslations('A11y');
  const [open, setOpen] = useState(false);
  return <>
    <Tooltip delay={400}>
      <Button isIconOnly variant="ghost" size="sm" aria-label={t('title')} onPress={() => setOpen(true)}><I name="accessibility" size={18}/></Button>
      <Tooltip.Content>{t('title')}</Tooltip.Content>
    </Tooltip>
    <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog className="sm:max-w-2xl">
          <Modal.CloseTrigger/>
          <Modal.Header><Modal.Heading>{t('title')}</Modal.Heading></Modal.Header>
          <Modal.Body><AccessibilitySettings/></Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </>;
}

// Applies the preferences to <html> and draws the reading guide (a band following the pointer).
export function AccessibilityRuntime() {
  const prefs = useA11y();
  const [y, setY] = useState<number | null>(null);
  useEffect(() => { applyA11y(prefs); }, [prefs]);
  useEffect(() => {
    if (prefs.guide !== 'on') { setY(null); return; }
    const move = (e: PointerEvent) => setY(e.clientY);
    window.addEventListener('pointermove', move, { passive: true });
    return () => window.removeEventListener('pointermove', move);
  }, [prefs.guide]);
  if (prefs.guide !== 'on' || y === null) return null;
  return <div aria-hidden className="pointer-events-none fixed inset-x-0 z-[9999] h-10 -translate-y-1/2 border-y-2 border-accent/70 bg-accent/10" style={{ top: y }}/>;
}
