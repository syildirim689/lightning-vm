"use client";
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { a11yDefaults, a11yStorageKey, type A11y } from './a11y-prefs';

export type { A11y } from './a11y-prefs';
export { a11yDefaults } from './a11y-prefs';

export const useA11y = create<A11y & { set: (patch: Partial<A11y>) => void; reset: () => void }>()(persist(
  (set) => ({ ...a11yDefaults, set: (patch) => set(patch), reset: () => set(a11yDefaults) }),
  { name: a11yStorageKey, storage: createJSONStorage(() => localStorage), partialize: ({ set: _s, reset: _r, ...prefs }) => prefs },
));

export function applyA11y(p: A11y) {
  const el = document.documentElement;
  for (const k of Object.keys(a11yDefaults) as (keyof A11y)[]) {
    if (p[k] === a11yDefaults[k]) delete el.dataset[`a11y${k[0].toUpperCase()}${k.slice(1)}`];
    else el.dataset[`a11y${k[0].toUpperCase()}${k.slice(1)}`] = p[k];
  }
}
