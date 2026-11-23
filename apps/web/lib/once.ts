"use client";
import { useRef } from 'react';

// Double submit. A second press of the same thing while the first is still on its way (a double click, Enter held
// down or pressed again, a click on a button that has not turned to "pending" yet) must not send a second request:
// it gets the first one's answer instead. Kept by key, so the same button on two different rows still runs twice.
// The API has its own guards behind this (Idempotency-Key on server operations, 409 for the same cookie POST while
// the first runs); this one stops the second request before it leaves the browser, for PUT and DELETE as well.
export function createOnce() {
  const running = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const going = running.get(key);
      if (going) return going as Promise<T>;
      const p = fn().finally(() => running.delete(key));
      running.set(key, p);
      return p;
    },
    busy: (key: string) => running.has(key),
  };
}
export type Once = ReturnType<typeof createOnce>;

export function useOnce(): Once {
  const ref = useRef<Once | null>(null);
  if (!ref.current) ref.current = createOnce();
  return ref.current;
}

// A stable key for "the same request": the variables as JSON (unserialisable ones never count as the same).
export function sameKey(vars: unknown): string {
  try { return JSON.stringify(vars ?? null); } catch { return `#${Math.random()}`; }
}
