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
    // A field that still holds the panel's proposal (lib/use-proposal.ts) is no work of the person's to lose.
    else if (el.value !== was && !el.matches('[data-proposed]')) out.push(el);
  }
  return out;
};

export const hasPendingEdits = () => dirtyForms > 0 || changed().length > 0;

// The tab says so while text is unsaved ("✎ Account"), after the unread count the notification bell puts in front,
// so a panel left in another tab is not closed by mistake. Pages set their own title on navigation; it is put back.
const mark = '\u270E ';
const titled = /^(\(\d+\+?\) )?(\u270E )?/;
export function syncTitle() {
  if (typeof document === 'undefined') return;
  const was = document.title;
  const next = was.replace(titled, (_, count: string | undefined) => `${count ?? ''}${hasPendingEdits() ? mark : ''}`);
  if (next !== was) document.title = next;
}
// The changed fields by their visible label ("Project name"), at most five, for the leave dialog.
const labelOf = (el: HTMLInputElement | HTMLTextAreaElement) => {
  const by = el.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  return (el.labels?.[0]?.textContent || by || el.getAttribute('aria-label') || '').replace(/\s*\*\s*$/, '').trim();
};
export const editedLabels = () => [...new Set(changed().map(labelOf).filter(Boolean))].slice(0, 5);
// A form that tracks its own changes (useUnsaved) also handles Ctrl/⌘+S itself.
export const formsDirty = () => dirtyForms > 0;
// The first field with unsaved text, to take the person back to it.
export const firstEdited = () => changed()[0] ?? null;
// After a save: what is on screen now is the saved state.
export const editsSaved = () => { for (const el of first.keys()) first.set(el, el.value); syncTitle(); };
// The person chose to leave without saving.
export const forgetEdits = () => { first.clear(); syncTitle(); };
// Before going elsewhere from code (palette, shortcuts, menus): true when it may go now; otherwise the leave dialog
// (components/leave-guard.tsx) asks and goes itself if the person chooses to leave.
export const mayLeave = (href: string) => {
  if (typeof window === 'undefined' || !hasPendingEdits()) return true;
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return true;
  window.dispatchEvent(new CustomEvent('lvm:leave', { detail: url.pathname + url.search + url.hash }));
  return false;
};
export const formDirty = (on: boolean) => { dirtyForms = Math.max(0, dirtyForms + (on ? 1 : -1)); syncTitle(); };

export function watchEdits() {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  // The value before the first change: on focus, or just before typing for a field that took the focus before this
  // started watching (autofocus) or that is changed without being focused.
  const note = (el: Element | null) => { if (el && textual(el) && !ignored(el) && !first.has(el)) first.set(el, el.value); };
  document.addEventListener('focusin', (e) => note(e.target as Element | null), true);
  document.addEventListener('beforeinput', (e) => note(e.target as Element | null), true);
  note(document.activeElement);
  document.addEventListener('input', syncTitle, true);
  document.addEventListener('focusout', () => setTimeout(syncTitle), true); // a dialog closed with its text
  new MutationObserver(syncTitle).observe(document.head, { childList: true, characterData: true, subtree: true });
  window.addEventListener('beforeunload', (e) => { if (hasPendingEdits()) e.preventDefault(); });
}
