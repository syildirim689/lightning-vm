"use client";
// Whether the person has typed something that has not been saved yet: a text field whose value differs from what it
// held when it was first focused (since the last successful save), or a form that says so through useUnsaved.
// Filters, search boxes, "type the name to confirm" fields and the terminal do not count; neither do fields that are
// gone (a dialog closed with Cancel). Used to keep the page when the session runs out and to ask before leaving it.
const first = new Map<HTMLInputElement | HTMLTextAreaElement, string>();
let dirtyForms = 0;
let watching = false;

const textual = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !/^(checkbox|radio|range|file|hidden|button|submit|reset|color|search)$/.test(el.type));
const ignored = (el: Element) =>
  el.matches('[role="searchbox"], [role="combobox"][aria-autocomplete], [readonly]') || !!el.closest('[data-transient], [role="search"], [cmdk-root], [data-palette], .xterm');

const changed = () => {
  const out: (HTMLInputElement | HTMLTextAreaElement)[] = [];
  for (const [el, was] of first) {
    if (!el.isConnected) first.delete(el);
    else if (el.value !== was) out.push(el);
  }
  return out;
};

export const hasPendingEdits = () => dirtyForms > 0 || changed().length > 0;
// The first field with unsaved text, to take the person back to it.
export const firstEdited = () => changed()[0] ?? null;
// After a save: what is on screen now is the saved state.
export const editsSaved = () => { for (const el of first.keys()) first.set(el, el.value); };
// The person chose to leave without saving.
export const forgetEdits = () => { first.clear(); };
export const formDirty = (on: boolean) => { dirtyForms = Math.max(0, dirtyForms + (on ? 1 : -1)); };

export function watchEdits() {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  // The value before the first change: on focus, or just before typing for a field that took the focus before this
  // started watching (autofocus) or that is changed without being focused.
  const note = (el: Element | null) => { if (el && textual(el) && !ignored(el) && !first.has(el)) first.set(el, el.value); };
  document.addEventListener('focusin', (e) => note(e.target as Element | null), true);
  document.addEventListener('beforeinput', (e) => note(e.target as Element | null), true);
  note(document.activeElement);
  window.addEventListener('beforeunload', (e) => { if (hasPendingEdits()) e.preventDefault(); });
}
