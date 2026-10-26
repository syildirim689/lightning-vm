"use client";
// The frame of the sign-in and registration forms: a sliding switch between the two, then the form,
// entering with a short rise. Motion follows the visitor's "reduce motion" setting.
import { LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

// Kept across the two pages: which tab was shown last, so a switch slides the right way and the card does not re-enter.
let lastTab: string | null = null;

export function AuthCard({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  const t = useTranslations('Auth');
  const path = usePathname();
  const tabs = [{ href: '/login', label: t('loginTitle') }, { href: '/register', label: t('registerTitle') }];
  const order = (p: string | null) => tabs.findIndex((x) => x.href === p);
  const [from] = useState(() => lastTab);
  useEffect(() => { lastTab = path; }, [path]);
  const switched = from !== null && order(from) >= 0 && from !== path;
  const dir = switched && order(path) < order(from) ? -1 : 1;
  return <motion.div initial={switched ? false : { opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 24 }}
    className="relative w-full max-w-md rounded-3xl border border-border bg-surface/80 p-6 shadow-xl shadow-black/10 backdrop-blur-xl sm:p-8">
    <div aria-hidden className="pointer-events-none absolute inset-x-10 -top-px h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent"/>
    <LayoutGroup>
      <nav aria-label={t('switchLabel')} className="mb-6 grid grid-cols-2 rounded-2xl bg-default p-1">
        {tabs.map((tab) => {
          const active = path === tab.href;
          return <NextLink key={tab.href} href={tab.href} aria-current={active ? 'page' : undefined}
            className="relative rounded-xl px-3 py-2 text-center text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {active && <motion.span layoutId="auth-tab" className="absolute inset-0 rounded-xl bg-surface shadow-sm" transition={{ type: 'spring', stiffness: 380, damping: 32 }}/>}
            <span className={`relative ${active ? 'text-foreground' : 'text-muted'}`}>{tab.label}</span>
          </NextLink>;
        })}
      </nav>
    </LayoutGroup>
    <motion.div key={path} initial={{ opacity: 0, x: 28 * dir, filter: 'blur(4px)' }} animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }} transition={{ type: 'spring', stiffness: 260, damping: 28 }}>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mb-6 mt-1 text-sm text-muted">{intro}</p>
      {children}
    </motion.div>
  </motion.div>;
}

// Rotates through the product points, one highlighted at a time.
export function Points({ items }: { items: { icon: React.ReactNode; text: string }[] }) {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const pulse = mounted && !reduced; // the looping highlight only after hydration
  return <ul className="flex flex-col gap-3">
    {items.map((p, i) => <motion.li key={p.text} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3 + i * 0.12 }}
      className="flex items-center gap-3 text-sm">
      <motion.span className="grid size-9 place-items-center rounded-xl bg-default text-accent"
        animate={!pulse ? undefined : { boxShadow: ['0 0 0 0 transparent', '0 0 0 6px color-mix(in oklab, var(--accent) 18%, transparent)', '0 0 0 0 transparent'] }}
        transition={{ duration: 2, repeat: Infinity, repeatDelay: items.length * 2 - 2, delay: 1 + i * 2 }}>{p.icon}</motion.span>
      {p.text}
    </motion.li>)}
  </ul>;
}
