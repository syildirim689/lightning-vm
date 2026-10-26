"use client";
// Outside signing in, no field is filled or remembered by the browser or a password manager. TextInput already
// renders this way; the guard covers every other field (search boxes, selects, number fields, third-party
// widgets) by setting the same attributes on whatever appears in the page. Fields marked data-autofill
// (the sign-in form) are left alone.
import { useEffect } from 'react';
import { noAutofill } from './ui';

const fields = 'input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, select';

function guard(root: Element | Document) {
  const all = [...(root instanceof Element && root.matches(`${fields}, form`) ? [root as HTMLElement] : []), ...root.querySelectorAll<HTMLElement>(`${fields}, form`)];
  for (const el of all) {
    if (el.closest('[data-autofill]') || (el.tagName === 'FORM' && el.querySelector('[data-autofill]'))) continue;
    for (const [k, v] of Object.entries(noAutofill)) if (el.getAttribute(k === 'autoComplete' ? 'autocomplete' : k) !== v) el.setAttribute(k === 'autoComplete' ? 'autocomplete' : k, v);
  }
}

export default function AutofillGuard() {
  useEffect(() => {
    guard(document);
    const seen = new MutationObserver((changes) => {
      for (const c of changes) for (const n of c.addedNodes) if (n instanceof HTMLElement) guard(n);
    });
    seen.observe(document.body, { childList: true, subtree: true });
    return () => seen.disconnect();
  }, []);
  return null;
}
