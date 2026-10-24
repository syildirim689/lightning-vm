"use client";
import { animate, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

// A number that counts up from 0 the first time it is seen; static for users who prefer reduced motion.
export default function CountUp({ value, format = (n) => String(Math.round(n)) }: { value: number; format?: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref, { once: true });
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  useEffect(() => {
    if (!seen || reduce) { setShown(value); return; }
    const c = animate(0, value, { duration: 0.8, ease: 'easeOut', onUpdate: setShown });
    return () => c.stop();
  }, [seen, value, reduce]);
  return <span ref={ref} className="tabular-nums">{format(shown)}</span>;
}
