"use client";
// Every dialog in the panel behaves like a window: it is moved by its title bar, made large and small again with
// a button (or a double click on the title bar), and stays inside the screen. This runs once for the whole panel
// (no dialog has to know about it); the look is in style.css (.modal__dialog and friends). On phones a dialog is a
// sheet from the bottom, so there is nothing to move there.
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';

const DIALOG = '.modal__dialog, .alert-dialog__dialog';
const HEADER = '.modal__header, .alert-dialog__header';
const CONTROL = 'button, a, input, select, textarea, [role="button"], [contenteditable="true"]';
const wide = () => window.matchMedia('(min-width: 640px)').matches;
const icons = {
  max: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  restore: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="8" width="12" height="12" rx="2"/><path d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"/></svg>',
};

export default function WindowChrome() {
  const t = useTranslations('Windows');
  const labels = useRef({ max: t('maximize'), restore: t('restore') });
  labels.current = { max: t('maximize'), restore: t('restore') };

  useEffect(() => {
    const toggle = (dialog: HTMLElement) => {
      const on = dialog.dataset.winMax === undefined;
      if (on) dialog.dataset.winMax = ''; else delete dialog.dataset.winMax;
      const b = dialog.querySelector<HTMLButtonElement>(':scope > .win-max');
      if (b) { b.innerHTML = on ? icons.restore : icons.max; b.setAttribute('aria-label', on ? labels.current.restore : labels.current.max); b.title = on ? labels.current.restore : labels.current.max; b.setAttribute('aria-pressed', String(on)); }
    };
    // A dialog with a title bar gets its "make large" button once, next to the close button.
    const dress = (root: ParentNode) => {
      for (const dialog of root.querySelectorAll<HTMLElement>('.modal__dialog:not([data-win])')) {
        if (!dialog.querySelector('.modal__header')) continue;
        dialog.dataset.win = '';
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'win-max'; b.innerHTML = icons.max; b.title = labels.current.max;
        b.setAttribute('aria-label', labels.current.max); b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => toggle(dialog));
        dialog.appendChild(b);
      }
    };
    dress(document);
    const seen = new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n instanceof HTMLElement && (n.matches('.modal__dialog') || n.querySelector('.modal__dialog'))) { dress(n.parentNode ?? document); return; }
    });
    seen.observe(document.body, { childList: true, subtree: true });

    let drag: { dialog: HTMLElement; header: HTMLElement; id: number; x: number; y: number; ox: number; oy: number; left: number; top: number; width: number } | null = null;
    const down = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      const header = target?.closest<HTMLElement>(HEADER);
      if (!header || e.button !== 0 || !wide() || target!.closest(CONTROL)) return;
      const dialog = header.closest<HTMLElement>(DIALOG);
      if (!dialog || dialog.dataset.winMax !== undefined) return;
      const r = dialog.getBoundingClientRect();
      drag = { dialog, header, id: e.pointerId, x: e.clientX, y: e.clientY, ox: parseFloat(dialog.style.getPropertyValue('--win-x')) || 0, oy: parseFloat(dialog.style.getPropertyValue('--win-y')) || 0, left: r.left, top: r.top, width: r.width };
      try { header.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
      dialog.dataset.winDrag = '';
      e.preventDefault(); // no text selection while moving
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      // The window stays inside the screen sideways (its buttons never leave it) and its title bar never goes above
      // the top edge or below the bottom one.
      const room = window.innerWidth - d.width - 16;
      const dx = room > 0 ? Math.min(8 + room - d.left, Math.max(8 - d.left, e.clientX - d.x)) : 0;
      const dy = Math.min(window.innerHeight - 64 - d.top, Math.max(8 - d.top, e.clientY - d.y));
      d.dialog.style.setProperty('--win-x', `${Math.round(d.ox + dx)}px`); d.dialog.style.setProperty('--win-y', `${Math.round(d.oy + dy)}px`);
    };
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      try { drag.header.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      delete drag.dialog.dataset.winDrag; drag = null;
    };
    const twice = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const header = target?.closest<HTMLElement>('.modal__header');
      if (!header || !wide() || target!.closest(CONTROL)) return;
      const dialog = header.closest<HTMLElement>('.modal__dialog');
      if (dialog?.dataset.win !== undefined) toggle(dialog);
    };
    // A smaller screen (or a turned phone): windows go back to the middle rather than end up outside it.
    const resized = () => { for (const d of document.querySelectorAll<HTMLElement>(DIALOG)) { d.style.removeProperty('--win-x'); d.style.removeProperty('--win-y'); } };
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('dblclick', twice);
    window.addEventListener('resize', resized);
    return () => {
      seen.disconnect();
      document.removeEventListener('pointerdown', down); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up); document.removeEventListener('dblclick', twice); window.removeEventListener('resize', resized);
    };
  }, []);
  return null;
}
