"use client";
// Every dialog in the panel is a window, the way a desktop has them: a title bar to move it by (it turns slightly
// see-through while moving), and three buttons - put aside, make large, close. Pulled against the top edge it
// becomes large; a double click on the title bar does the same. Put aside, it waits as a small bar at the bottom
// left and the page behind is usable again (scroll, click, type); a click on the bar (or Escape) brings it back.
// A window belongs to its page: going to another page closes it. This runs once for the whole panel - no dialog
// has to know about it; the look is in style.css. On phones a dialog is a sheet from the bottom.
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';

const DIALOG = '.modal__dialog, .alert-dialog__dialog';
const HEADER = '.modal__header, .alert-dialog__header';
const CONTROL = 'button, a, input, select, textarea, [role="button"], [contenteditable="true"]';
const wide = () => window.matchMedia('(min-width: 640px)').matches;
const svg = (d: string) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const icons = {
  min: svg('<path d="M6 12h12"/>'),
  max: svg('<rect x="5" y="5" width="14" height="14" rx="1.5"/>'),
  restore: svg('<rect x="5" y="8.5" width="10.5" height="10.5" rx="1.5"/><path d="M9 8.5V6.5A1.5 1.5 0 0 1 10.5 5h7A1.5 1.5 0 0 1 19 6.5v7a1.5 1.5 0 0 1-1.5 1.5h-2"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
};

export default function WindowChrome() {
  const t = useTranslations('Windows');
  const labels = useRef({ min: t('minimize'), max: t('maximize'), restore: t('restore'), close: t('close'), bring: t('bringBack') });
  labels.current = { min: t('minimize'), max: t('maximize'), restore: t('restore'), close: t('close'), bring: t('bringBack') };

  useEffect(() => {
    const name = (b: HTMLElement, label: string) => { b.setAttribute('aria-label', label); b.title = label; };
    const large = (dialog: HTMLElement, on: boolean) => {
      if (on) { dialog.dataset.winMax = ''; delete dialog.dataset.winMin; } else delete dialog.dataset.winMax;
      const b = dialog.querySelector<HTMLButtonElement>('.win-controls [data-win-act="max"]');
      if (b) { b.innerHTML = on ? icons.restore : icons.max; name(b, on ? labels.current.restore : labels.current.max); }
    };
    // While a window waits, the page is given back: what the dialog hid from assistive technology is shown again,
    // and a click on the page is not taken as "clicked outside the dialog, close it".
    let hidden: Element[] = [], frozen: HTMLElement[] = [];
    const aside = (dialog: HTMLElement, on: boolean) => {
      if (on) {
        dialog.dataset.winMin = ''; dialog.setAttribute('title', labels.current.bring);
        const overlay = dialog.closest('.modal__backdrop');
        hidden = [...document.querySelectorAll('[aria-hidden="true"]')].filter((el) => !overlay?.contains(el) && !el.contains(overlay ?? null) && el.closest('svg') === null && !el.matches('svg'));
        for (const el of hidden) el.removeAttribute('aria-hidden');
        frozen = [...document.querySelectorAll<HTMLElement>('[inert]')].filter((el) => !overlay?.contains(el) && !el.contains(overlay ?? null));
        for (const el of frozen) el.inert = false;
        document.body.setAttribute('data-react-aria-top-layer', 'true');
        (document.activeElement as HTMLElement | null)?.blur?.();
      } else {
        delete dialog.dataset.winMin; dialog.removeAttribute('title');
        for (const el of hidden) if (el.isConnected) el.setAttribute('aria-hidden', 'true');
        for (const el of frozen) if (el.isConnected) el.inert = true;
        hidden = []; frozen = [];
        document.body.removeAttribute('data-react-aria-top-layer');
        dialog.querySelector<HTMLElement>('.win-controls [data-win-act="min"]')?.focus({ preventScroll: true });
      }
    };
    const close = (dialog: HTMLElement) => {
      const own = dialog.querySelector<HTMLElement>('.modal__close-trigger');
      if (own) own.click(); else dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    };
    // A dialog with a title bar gets its three buttons once.
    const dress = (root: ParentNode) => {
      for (const dialog of root.querySelectorAll<HTMLElement>('.modal__dialog:not([data-win])')) {
        if (!dialog.querySelector('.modal__header')) continue;
        dialog.dataset.win = '';
        const bar = document.createElement('div');
        bar.className = 'win-controls';
        // The dialog's own close button stays (it becomes the third button of the bar); one is added only where there is none.
        const own = !!dialog.querySelector(':scope > .modal__close-trigger');
        if (own) dialog.dataset.winOwnClose = '';
        for (const act of (own ? ['min', 'max'] : ['min', 'max', 'close']) as ('min' | 'max' | 'close')[]) {
          const b = document.createElement('button');
          b.type = 'button'; b.dataset.winAct = act; b.innerHTML = icons[act]; name(b, labels.current[act]);
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            if (act === 'close') close(dialog); else if (act === 'max') large(dialog, dialog.dataset.winMax === undefined); else aside(dialog, true);
          });
          bar.appendChild(b);
        }
        dialog.appendChild(bar);
      }
    };
    dress(document);
    const seen = new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n instanceof HTMLElement && (n.matches('.modal__dialog') || n.querySelector('.modal__dialog'))) { dress(n.parentNode ?? document); return; }
    });
    seen.observe(document.body, { childList: true, subtree: true });

    const waiting = () => document.querySelector<HTMLElement>('.modal__dialog[data-win-min]');
    // A click on the waiting bar brings the window back; so does Escape (which would otherwise close it unseen).
    const back = (e: Event) => {
      const w = waiting();
      if (!w) { if (document.body.hasAttribute('data-react-aria-top-layer') && !document.querySelector('[data-win-min]')) document.body.removeAttribute('data-react-aria-top-layer'); return; }
      if (e instanceof KeyboardEvent) { if (e.key !== 'Escape') return; e.stopImmediatePropagation(); e.preventDefault(); aside(w, false); return; }
      const target = e.target as HTMLElement | null;
      if (!target || !w.contains(target) || target.closest('.modal__close-trigger, [data-win-act="close"]')) return;
      e.stopImmediatePropagation(); e.preventDefault();
      if (e.type === 'click') aside(w, false);
    };
    // The dialog keeps the keyboard focus inside itself; while it waits, focus may go anywhere on the page.
    const roam = (e: Event) => { const w = waiting(); if (w && !w.contains(e.target as Node)) e.stopImmediatePropagation(); };

    let drag: { dialog: HTMLElement; header: HTMLElement; id: number; x: number; y: number; ox: number; oy: number; left: number; top: number; width: number; moved: boolean } | null = null;
    const down = (e: PointerEvent) => {
      if (waiting()) return;
      const target = e.target as HTMLElement | null;
      const header = target?.closest<HTMLElement>(HEADER);
      if (!header || e.button !== 0 || !wide() || target!.closest(CONTROL)) return;
      const dialog = header.closest<HTMLElement>(DIALOG);
      if (!dialog || dialog.dataset.winMax !== undefined) return;
      const r = dialog.getBoundingClientRect();
      drag = { dialog, header, id: e.pointerId, x: e.clientX, y: e.clientY, ox: parseFloat(dialog.style.getPropertyValue('--win-x')) || 0, oy: parseFloat(dialog.style.getPropertyValue('--win-y')) || 0, left: r.left, top: r.top, width: r.width, moved: false };
      try { header.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
      e.preventDefault(); // no text selection while moving
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      if (!d.moved) { if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 4) return; d.moved = true; d.dialog.dataset.winDrag = ''; }
      // The window stays inside the screen sideways (its buttons never leave it) and its title bar never goes above
      // the top edge or below the bottom one.
      const room = window.innerWidth - d.width - 16;
      const dx = room > 0 ? Math.min(8 + room - d.left, Math.max(8 - d.left, e.clientX - d.x)) : 0;
      const dy = Math.min(window.innerHeight - 64 - d.top, Math.max(8 - d.top, e.clientY - d.y));
      d.dialog.style.setProperty('--win-x', `${Math.round(d.ox + dx)}px`); d.dialog.style.setProperty('--win-y', `${Math.round(d.oy + dy)}px`);
      // Against the top edge: letting go makes it large.
      if (d.dialog.dataset.win !== undefined) { if (e.clientY <= 6) d.dialog.dataset.winSnap = ''; else delete d.dialog.dataset.winSnap; }
    };
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      try { d.header.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      delete d.dialog.dataset.winDrag;
      if (d.dialog.dataset.winSnap !== undefined) {
        delete d.dialog.dataset.winSnap;
        d.dialog.style.setProperty('--win-x', `${d.ox}px`); d.dialog.style.setProperty('--win-y', `${d.oy}px`);
        large(d.dialog, true);
      }
    };
    const twice = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const header = target?.closest<HTMLElement>('.modal__header');
      if (!header || !wide() || target!.closest(CONTROL)) return;
      const dialog = header.closest<HTMLElement>('.modal__dialog');
      if (dialog?.dataset.win !== undefined && dialog.dataset.winMin === undefined) large(dialog, dialog.dataset.winMax === undefined);
    };
    // A smaller screen (or a turned phone): windows go back to the middle rather than end up outside it.
    const resized = () => { for (const d of document.querySelectorAll<HTMLElement>(DIALOG)) { d.style.removeProperty('--win-x'); d.style.removeProperty('--win-y'); } };
    const early = { capture: true } as const;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown'] as const) window.addEventListener(type, back, early);
    document.addEventListener('focusin', roam);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('dblclick', twice);
    window.addEventListener('resize', resized);
    return () => {
      seen.disconnect();
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown'] as const) window.removeEventListener(type, back, early);
      document.removeEventListener('focusin', roam); document.body.removeAttribute('data-react-aria-top-layer');
      document.removeEventListener('pointerdown', down); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up); document.removeEventListener('dblclick', twice); window.removeEventListener('resize', resized);
    };
  }, []);
  return null;
}
