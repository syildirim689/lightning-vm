"use client";
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { a11yDefaults, a11yNumber, a11yStorageKey, type A11y } from './a11y-prefs';

export type { A11y } from './a11y-prefs';
export { a11yDefaults } from './a11y-prefs';

export const useA11y = create<A11y & { set: (patch: Partial<A11y>) => void; reset: () => void }>()(persist(
  (set) => ({ ...a11yDefaults, set: (patch) => set(patch), reset: () => set(a11yDefaults) }),
  { name: a11yStorageKey, storage: createJSONStorage(() => localStorage), partialize: ({ set: _s, reset: _r, ...prefs }) => prefs },
));

export function applyA11y(p: A11y) {
  const el = document.documentElement;
  // The two scales: the root font size (everything is sized in rem) and how far letters, words and lines are apart.
  const text = a11yNumber('text', p.text), spacing = a11yNumber('spacing', p.spacing);
  el.style.fontSize = text === 100 ? '' : `${text}%`;
  if (spacing > 0) { el.dataset.a11ySpacing = 'on'; el.style.setProperty('--a11y-spacing', String(spacing)); }
  else { delete el.dataset.a11ySpacing; el.style.removeProperty('--a11y-spacing'); }
  for (const k of Object.keys(a11yDefaults) as (keyof A11y)[]) {
    if (k === 'text' || k === 'spacing') continue;
    if (p[k] === a11yDefaults[k]) delete el.dataset[`a11y${k[0].toUpperCase()}${k.slice(1)}`];
    else el.dataset[`a11y${k[0].toUpperCase()}${k.slice(1)}`] = p[k];
  }
}
