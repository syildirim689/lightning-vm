"use client";
// Whether the person has typed something that has not been saved yet: any change in a form field (search boxes
// aside) since the last successful save. Used when the session runs out, so the page is not thrown away with it.
let pending = false;
let watching = false;

export const hasPendingEdits = () => pending;
export const editsSaved = () => { pending = false; };

export function watchEdits() {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  const mark = (e: Event) => {
    const el = e.target as HTMLElement | null;
    if (!el || !el.matches('input, textarea, select, [contenteditable="true"]')) return;
    if (el.matches('[type="search"], [role="searchbox"], [role="combobox"][aria-autocomplete]') || el.closest('[role="search"], [cmdk-root], [data-palette]')) return;
    pending = true;
  };
  document.addEventListener('input', mark, true);
  document.addEventListener('change', mark, true);
}
