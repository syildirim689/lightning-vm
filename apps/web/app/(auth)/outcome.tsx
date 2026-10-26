"use client";
// What signing in feels like: a check that draws itself with a ripple when it worked, a short red glow (with the
// form's shake) when it did not. Both are decorative; the text and the error notice carry the meaning, and
// "reduce motion" keeps only the end state.
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

export function SuccessOverlay({ show, label }: { show: boolean; label: string }) {
  const still = useReducedMotion();
  return <AnimatePresence>
    {show && <motion.div role="status" aria-live="polite" className="absolute -inset-2 z-10 grid place-items-center rounded-2xl bg-surface/85 backdrop-blur-sm"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: still ? 0 : 0.2 }}>
      <div className="flex flex-col items-center gap-3">
        <div className="relative grid size-20 place-items-center">
          {!still && <motion.span aria-hidden className="absolute inset-0 rounded-full border-2 border-success"
            initial={{ scale: 0.6, opacity: 0.8 }} animate={{ scale: 1.8, opacity: 0 }} transition={{ duration: 0.9, ease: 'easeOut', delay: 0.15 }}/>}
          <motion.span aria-hidden className="absolute inset-0 rounded-full bg-success/15"
            initial={still ? false : { scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 320, damping: 18 }}/>
          <svg viewBox="0 0 52 52" className="relative size-12 text-success" aria-hidden fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
            <motion.path d="M14 27 L23 36 L39 18" initial={still ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.45, delay: 0.15, ease: 'easeOut' }}/>
          </svg>
        </div>
        <motion.p className="text-sm font-medium" initial={still ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}>{label}</motion.p>
      </div>
    </motion.div>}
  </AnimatePresence>;
}

// A new key for every failure replays the glow.
export function FailureGlow({ count }: { count: number }) {
  const still = useReducedMotion();
  if (!count || still) return null;
  return <motion.span key={count} aria-hidden className="pointer-events-none absolute -inset-3 rounded-2xl bg-danger/5 ring-2 ring-danger/50"
    initial={{ opacity: 0.9 }} animate={{ opacity: 0 }} transition={{ duration: 0.9, ease: 'easeOut' }}/>;
}
