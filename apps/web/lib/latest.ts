"use client";
import { useRef } from 'react';

// Stale answers. A request that was overtaken (the step changed, the person typed a newer value and checked again,
// a later save went out) must not write its answer over a newer one. One pattern for the panel's own calls outside
// React Query (which keys its cache by the request and has no such race):
//   const isLatest = latest.begin();  const r = await apiFetch(…);  if (!isLatest()) return;  setResult(r);
export function createLatest() {
  let current = 0;
  return {
    // Starts a request; the function it returns says whether that request is still the newest one.
    begin(): () => boolean { const id = ++current; return () => id === current; },
    // Nothing that was started counts any more (the step or page was left).
    drop() { current++; },
  };
}
export type Latest = ReturnType<typeof createLatest>;

export function useLatest(): Latest {
  const ref = useRef<Latest | null>(null);
  if (!ref.current) ref.current = createLatest();
  return ref.current;
}

// A form saved while the person went on typing: the saved document replaces the form only when the form is still
// the one that was sent (same object); edits made meanwhile stay on the screen, still unsaved.
// Usage: const sent = v; const r = await save(sent); setV(keepEdits(sent, r));
export function keepEdits<T>(sent: T, answer: T) {
  return (now: T): T => (now === sent ? answer : now);
}
