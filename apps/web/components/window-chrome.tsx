"use client";
// Every dialog in the panel is a window, the way a desktop has them: a title bar to move it by (it turns slightly
// see-through while moving), and four buttons - layout, put aside, make large, close. Put aside, it waits as a small
// bar at the bottom left and the page behind is usable again (scroll, click, type); a click on the bar (or Escape)
// brings it back, in the layout it had. A window belongs to its page: going to another page closes it.
//
// Layouts (data-win-layout, drawn by style.css with the numbers of lib/windows.ts): a half, a quarter or the whole
// screen, 8 px from the edges. A window gets one from the layout menu (the first button, or a right click on the
// title bar), from the keys (Ctrl+Alt+←/→ halves, ↑ whole screen, ↓ back to its own size - or put aside when it
// already has it -, C centre; ⌃⌥ on a Mac), by being dragged against an edge (left/right: that half, top: whole
// screen, a corner: that quarter; a see-through rectangle shows where it will land) or by a double click on the
// title bar (whole screen and back). Dragged by its title bar, a window in a layout comes out of it under the pointer.
//
// Its own size and place stay underneath every layout: "own size and place" (and ↓, or a drag out) returns to them.
// In its own size a window can be resized from its right edge, bottom edge and corner grip (--win-w/--win-h, never
// smaller than 320 × 200 nor past the screen), its top-left corner staying put; "centre" keeps that size and drops
// the place; a double click on the grip (or "reset size" in the menu) gives back the natural size, from the same corner. A screen that becomes too small drops a place or size that no
// longer fits; a layout fits any screen. Alert dialogs (confirmations) can only be moved.
//
// This runs once for the whole panel - no dialog has to know about it; the look is in style.css. On phones (under
// 640 px) a dialog is a sheet from the bottom and none of this applies.
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { areas, clampSize, isLayout, keyAction, keyHints, layouts, menuStep, pullOut, snapAt, type Layout } from '../lib/windows';

const DIALOG = '.modal__dialog, .alert-dialog__dialog';
const HEADER = '.modal__header, .alert-dialog__header';
const CONTROL = 'button, a, input, select, textarea, [role="button"], [contenteditable="true"]';
const wide = () => window.matchMedia('(min-width: 640px)').matches;
const svg = (d: string) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const icons = {
  layout: svg('<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M11 5v14M11 12h9"/>'),
  min: svg('<path d="M6 12h12"/>'),
  max: svg('<rect x="5" y="5" width="14" height="14" rx="1.5"/>'),
  restore: svg('<rect x="5" y="8.5" width="10.5" height="10.5" rx="1.5"/><path d="M9 8.5V6.5A1.5 1.5 0 0 1 10.5 5h7A1.5 1.5 0 0 1 19 6.5v7a1.5 1.5 0 0 1-1.5 1.5h-2"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
};
// The menu's picture of a layout: a small screen with the part the window takes filled in.
const mini = (l: Layout) => {
  const [x, y, w, h] = areas[l], g = 1.5;
  return `<svg viewBox="0 0 30 20" width="30" height="20" aria-hidden="true"><rect x="0.75" y="0.75" width="28.5" height="18.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>`
    + `<rect x="${2.5 + x * (25 + g)}" y="${2.5 + y * (15 + g)}" width="${w * (25 + g) - g}" height="${h * (15 + g) - g}" rx="1.2" fill="currentColor"/></svg>`;
};
type Act = Layout | 'centre' | 'back' | 'resetSize' | 'aside' | 'shut';

export default function WindowChrome() {
  const t = useTranslations('Windows');
  const read = () => ({
    min: t('minimize'), max: t('maximize'), restore: t('restore'), close: t('close'), bring: t('bringBack'), layout: t('layout'), layouts: t('layouts'),
    centre: t('centre'), back: t('back'), resetSize: t('resetSize'), aside: t('aside'), shut: t('shut'), resize: t('resize'),
    at: Object.fromEntries(layouts.map((l) => [l, t(l)])) as Record<Layout, string>,
  });
  const labels = useRef(read());
  labels.current = read();

  useEffect(() => {
    const hints = keyHints(/Mac|iP(hone|ad|od)/.test(navigator.platform));
    const name = (b: HTMLElement, label: string, hint?: string) => { b.setAttribute('aria-label', label); b.title = hint ? `${label} (${hint})` : label; };
    const num = (d: HTMLElement, v: string) => parseFloat(d.style.getPropertyValue(v)) || 0;
    const place = (d: HTMLElement, x: number, y: number) => { d.style.setProperty('--win-x', `${Math.round(x)}px`); d.style.setProperty('--win-y', `${Math.round(y)}px`); };
    const unplace = (d: HTMLElement) => { d.style.removeProperty('--win-x'); d.style.removeProperty('--win-y'); };
    const unsize = (d: HTMLElement) => { delete d.dataset.winSized; d.style.removeProperty('--win-w'); d.style.removeProperty('--win-h'); };
    const layoutOf = (d: HTMLElement) => { const l = d.dataset.winLayout; return isLayout(l) ? l : null; };
    // The window sits in the middle of its container, so a new size moves its corner: put the corner back.
    const keepCorner = (d: HTMLElement, left: number, top: number) => {
      const r = d.getBoundingClientRect();
      if (Math.abs(r.left - left) > 0.5 || Math.abs(r.top - top) > 0.5) place(d, num(d, '--win-x') + left - r.left, num(d, '--win-y') + top - r.top);
    };

    // A place or size the screen no longer has room for is dropped (the window goes back to the middle, or to its
    // natural size); on a phone width every place goes (a sheet does not move). A layout always fits.
    const fit = (d: HTMLElement) => {
      if (!wide()) { unplace(d); return; }
      if (d.dataset.winSized !== undefined && (num(d, '--win-w') > window.innerWidth - 16 || num(d, '--win-h') > window.innerHeight - 16)) unsize(d);
      if (layoutOf(d) || d.dataset.winMin !== undefined) return;
      const r = d.getBoundingClientRect();
      if (r.left < 0 || r.right > window.innerWidth || r.top < 0 || r.top > window.innerHeight - 64) unplace(d);
    };
    // A short movement for a change of layout: between two layouts (and when centred) the window glides; into or out
    // of one it grows into place. Reduced motion makes both instant (style.css); never while dragged or resized.
    const timers = new WeakMap<HTMLElement, number>();
    const animate = (d: HTMLElement, glide: boolean) => {
      delete d.dataset.winPop; delete d.dataset.winGlide;
      if (glide) d.dataset.winGlide = ''; else { void d.offsetWidth; d.dataset.winPop = ''; } // restart the animation
      window.clearTimeout(timers.get(d));
      timers.set(d, window.setTimeout(() => { delete d.dataset.winPop; delete d.dataset.winGlide; }, 260));
    };
    const arrange = (d: HTMLElement, layout: Layout | null, quiet = false) => {
      const was = layoutOf(d);
      if (layout) d.dataset.winLayout = layout; else delete d.dataset.winLayout;
      const b = d.querySelector<HTMLButtonElement>('.win-controls [data-win-act="max"]');
      if (b) { const on = layout === 'max'; b.innerHTML = on ? icons.restore : icons.max; name(b, on ? labels.current.restore : labels.current.max, on ? hints.restore : hints.max); }
      if (!layout) fit(d);
      if (!quiet && was !== layout) animate(d, !!was && !!layout);
    };
    // Its natural size again, from the same top-left corner (unless it then sticks out of the screen).
    const reset = (d: HTMLElement) => {
      if (d.dataset.winSized === undefined) return;
      const r = d.getBoundingClientRect();
      unsize(d);
      if (!layoutOf(d)) keepCorner(d, r.left, r.top);
      fit(d);
    };
    const centre = (d: HTMLElement) => {
      const was = layoutOf(d);
      unplace(d);
      // A size of its own stays, as long as it fits in the middle.
      if (d.dataset.winSized !== undefined) {
        d.style.setProperty('--win-w', `${Math.round(Math.min(num(d, '--win-w'), window.innerWidth - 48))}px`);
        d.style.setProperty('--win-h', `${Math.round(Math.min(num(d, '--win-h'), window.innerHeight - 48))}px`);
      }
      arrange(d, null, !was);
      if (!was) animate(d, true);
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

    // The layout menu: the nine layouts as a 3 × 3 grid of small pictures, then centre, own size and place, reset size,
    // put aside and close. It is built inside the dialog (the dialog keeps the focus inside itself and makes the rest
    // of the page inert) and only while open; Escape closes the menu alone and focus goes back where it was.
    let menu: { el: HTMLElement; dialog: HTMLElement; back: HTMLElement | null; trigger: HTMLElement | null } | null = null;
    const shut = (refocus: boolean) => {
      if (!menu) return;
      const m = menu; menu = null;
      m.el.remove(); delete m.dialog.dataset.winMenu; m.trigger?.setAttribute('aria-expanded', 'false');
      if (refocus && m.back?.isConnected) m.back.focus({ preventScroll: true });
    };
    const run = (d: HTMLElement, act: Act) => {
      if (act === 'aside') { shut(false); aside(d, true); return; }
      if (act === 'shut') { shut(false); close(d); return; }
      shut(true);
      if (isLayout(act)) arrange(d, act);
      else if (act === 'centre') centre(d);
      else if (act === 'back') arrange(d, null);
      else reset(d);
    };
    const menuKey = (e: KeyboardEvent) => {
      if (!menu) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); shut(true); return; }
      if (e.key === 'Tab') { shut(true); return; } // and the Tab goes on from where the focus came from
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const items = [...menu.el.querySelectorAll<HTMLElement>('[role="menuitem"]:not([hidden])')];
      const i = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
      items[menuStep(i, e.key, items.length)]?.focus();
    };
    const open = (d: HTMLElement, at: { x: number; y: number } | null, trigger: HTMLElement | null) => {
      shut(false);
      const L = labels.current, now = layoutOf(d);
      const el = document.createElement('div');
      el.className = 'win-menu'; el.setAttribute('role', 'menu'); el.setAttribute('aria-label', L.layout);
      const item = (act: Act, label: string, hint?: string, keys?: string) => {
        const b = document.createElement('button');
        b.type = 'button'; b.tabIndex = -1; b.setAttribute('role', 'menuitem'); b.dataset.winTo = act; name(b, label, hint);
        if (keys) b.setAttribute('aria-keyshortcuts', keys);
        b.addEventListener('click', (e) => { e.stopPropagation(); run(d, act); });
        return b;
      };
      const keysOf = { left: 'Control+Alt+ArrowLeft', right: 'Control+Alt+ArrowRight', max: 'Control+Alt+ArrowUp', restore: 'Control+Alt+ArrowDown', centre: 'Control+Alt+C' } as const;
      const grid = document.createElement('div');
      grid.className = 'win-menu-grid'; grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', L.layouts);
      for (const l of layouts) {
        const keyed = l === 'left' || l === 'right' || l === 'max' ? l : null;
        const b = item(l, L.at[l], keyed ? hints[keyed] : undefined, keyed ? keysOf[keyed] : undefined);
        b.innerHTML = mini(l);
        if (l === now) { b.dataset.current = ''; b.setAttribute('aria-current', 'true'); }
        grid.appendChild(b);
      }
      el.appendChild(grid);
      const sep = document.createElement('div');
      sep.className = 'win-menu-sep'; sep.setAttribute('role', 'separator');
      el.appendChild(sep);
      const text: [Act, string, string | undefined, string | undefined, boolean][] = [
        ['centre', L.centre, hints.centre, keysOf.centre, true],
        ['back', L.back, hints.restore, keysOf.restore, !!now],
        ['resetSize', L.resetSize, undefined, undefined, d.dataset.winSized !== undefined],
        ['aside', L.aside, undefined, undefined, true],
        ['shut', L.shut, undefined, undefined, true],
      ];
      for (const [act, label, hint, keys, shown] of text) {
        const b = item(act, label, hint, keys);
        const span = document.createElement('span'); span.textContent = label; b.appendChild(span);
        if (hint) { const k = document.createElement('kbd'); k.textContent = hint; k.setAttribute('aria-hidden', 'true'); b.appendChild(k); }
        if (act === 'shut') b.dataset.danger = '';
        b.hidden = !shown;
        el.appendChild(b);
      }
      el.addEventListener('keydown', menuKey);
      el.addEventListener('focusout', (e) => { if (menu?.el === el && !el.contains(e.relatedTarget as Node | null)) shut(false); });
      d.dataset.winMenu = '';
      d.appendChild(el);
      // Under its button (or at the pointer), kept on the screen; the dialog lets it stick out while it is open.
      const r = d.getBoundingClientRect(), mw = el.offsetWidth, mh = el.offsetHeight;
      const tr = trigger?.getBoundingClientRect();
      const x = tr ? tr.right - mw : at!.x, y = tr ? tr.bottom + 4 : at!.y;
      el.style.left = `${Math.round(Math.max(8, Math.min(x, window.innerWidth - mw - 8)) - r.left)}px`;
      el.style.top = `${Math.round(Math.max(8, Math.min(y, window.innerHeight - mh - 8)) - r.top)}px`;
      menu = { el, dialog: d, back: document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : trigger, trigger };
      trigger?.setAttribute('aria-expanded', 'true');
      (el.querySelector<HTMLElement>('[data-current]') ?? el.querySelector<HTMLElement>('[role="menuitem"]'))?.focus({ preventScroll: true });
    };

    // A dialog with a title bar gets its buttons and resize grips once.
    const dress = (root: ParentNode) => {
      for (const dialog of root.querySelectorAll<HTMLElement>('.modal__dialog:not([data-win])')) {
        if (!dialog.querySelector('.modal__header')) continue;
        dialog.dataset.win = '';
        const bar = document.createElement('div');
        bar.className = 'win-controls';
        // The dialog's own close button stays (it becomes the last button of the bar); one is added only where there is none.
        const own = !!dialog.querySelector(':scope > .modal__close-trigger');
        if (own) dialog.dataset.winOwnClose = '';
        for (const act of (own ? ['layout', 'min', 'max'] : ['layout', 'min', 'max', 'close']) as ('layout' | 'min' | 'max' | 'close')[]) {
          const b = document.createElement('button');
          b.type = 'button'; b.dataset.winAct = act; b.innerHTML = icons[act];
          name(b, labels.current[act], act === 'max' ? hints.max : undefined);
          if (act === 'layout') { b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); }
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            if (act === 'close') close(dialog);
            else if (act === 'max') arrange(dialog, layoutOf(dialog) === 'max' ? null : 'max');
            else if (act === 'layout') { if (menu?.dialog === dialog) shut(true); else open(dialog, null, b); }
            else aside(dialog, true);
          });
          bar.appendChild(b);
        }
        dialog.appendChild(bar);
        for (const dir of ['e', 's', 'se']) {
          const grip = document.createElement('div');
          grip.className = 'win-grip'; grip.dataset.winGrip = dir; grip.setAttribute('aria-hidden', 'true');
          if (dir === 'se') grip.title = labels.current.resize;
          dialog.appendChild(grip);
        }
      }
    };
    dress(document);
    // The keyboard stays with the window in front. What had the focus can leave the page with what it did (a button
    // that confirms "stop" and is gone once that is done, its question still closing): the focus is then nowhere, and
    // Escape, which a dialog hears only from inside itself, would close nothing. One frame later (whoever closes gives
    // the focus back within that frame, where there is something to give it back to) it is put on the window in front.
    let stray = 0;
    const keep = () => {
      if (stray || document.activeElement !== document.body) return;
      stray = requestAnimationFrame(() => {
        stray = 0;
        if (document.activeElement !== document.body || waiting()) return;
        const front = [...document.querySelectorAll<HTMLElement>(DIALOG)].filter((d) => !d.closest('[data-exiting]')).at(-1);
        front?.focus({ preventScroll: true });
      });
    };
    const seen = new MutationObserver((list) => {
      if (list.some((m) => m.removedNodes.length)) keep();
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

    // The keys act on the window that has the focus. Ctrl+Alt with an arrow types nothing anywhere; Ctrl+Alt+C is
    // AltGr+C on Windows, which types a letter on some keyboard layouts (ć in Polish), so it is left alone in a text
    // field. A terminal or a remote console in a window gets every key itself.
    const keys = (e: KeyboardEvent) => {
      const act = keyAction(e);
      if (!act || !wide()) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const shown = [...document.querySelectorAll<HTMLElement>('.modal__dialog[data-win]:not([data-win-min])')];
      const d = target?.closest<HTMLElement>('.modal__dialog[data-win]') ?? (shown.length === 1 ? shown[0] : null);
      if (!d || d.dataset.winMin !== undefined || target?.closest('.xterm, .wmks, canvas')) return;
      if (act === 'centre' && target && (target.isContentEditable || target.matches('input, textarea, select'))) return;
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      shut(false);
      if (act === 'centre') centre(d);
      else if (act === 'restore') { if (layoutOf(d)) arrange(d, null); else aside(d, true); }
      else arrange(d, act); // the same half twice stays that half
    };

    // The see-through rectangle where a dragged window would land. It lives in the dialog's backdrop, before the
    // window, so it is drawn under it; only while dragging.
    let ghost: HTMLElement | null = null;
    const preview = (d: HTMLElement | null, to: Layout | null) => {
      if (!d || !to) { ghost?.remove(); ghost = null; return; }
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'win-preview'; ghost.setAttribute('aria-hidden', 'true');
        (d.closest('.modal__backdrop') ?? document.body).prepend(ghost);
      }
      ghost.dataset.winLayout = to;
    };

    type Move = { kind: 'move'; dialog: HTMLElement; el: HTMLElement; id: number; x: number; y: number; ox: number; oy: number; left: number; top: number; width: number; moved: boolean; layout: Layout | null; grab: { fx: number; dy: number } };
    type Size = { kind: 'size'; dialog: HTMLElement; el: HTMLElement; id: number; x: number; y: number; dir: string; w: number; h: number; left: number; top: number; moved: boolean };
    let drag: Move | Size | null = null;
    const down = (e: PointerEvent) => {
      if (waiting()) return;
      const target = e.target as HTMLElement | null;
      if (!target || e.button !== 0 || !wide()) return;
      const grip = target.closest<HTMLElement>('.modal__dialog[data-win] > [data-win-grip]');
      if (grip) {
        const dialog = grip.parentElement!;
        if (layoutOf(dialog)) return;
        const r = dialog.getBoundingClientRect();
        drag = { kind: 'size', dialog, el: grip, id: e.pointerId, x: e.clientX, y: e.clientY, dir: grip.dataset.winGrip ?? 'se', w: r.width, h: r.height, left: r.left, top: r.top, moved: false };
      } else {
        const header = target.closest<HTMLElement>(HEADER);
        if (!header || target.closest(CONTROL)) return;
        const dialog = header.closest<HTMLElement>(DIALOG);
        if (!dialog) return;
        const r = dialog.getBoundingClientRect();
        drag = { kind: 'move', dialog, el: header, id: e.pointerId, x: e.clientX, y: e.clientY, ox: num(dialog, '--win-x'), oy: num(dialog, '--win-y'), left: r.left, top: r.top, width: r.width, moved: false,
          layout: layoutOf(dialog), grab: { fx: (e.clientX - r.left) / r.width, dy: e.clientY - r.top } };
      }
      try { drag.el.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
      e.preventDefault(); // no text selection while moving
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag, view = { width: window.innerWidth, height: window.innerHeight };
      if (d.kind === 'size') {
        if (!d.moved) {
          if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 3) return;
          d.moved = true; shut(false);
          d.dialog.dataset.winResize = ''; d.dialog.dataset.winSized = '';
        }
        const s = clampSize({ width: d.w + (d.dir.includes('e') ? e.clientX - d.x : 0), height: d.h + (d.dir.includes('s') ? e.clientY - d.y : 0) }, d, view);
        d.dialog.style.setProperty('--win-w', `${s.width}px`); d.dialog.style.setProperty('--win-h', `${s.height}px`);
        keepCorner(d.dialog, d.left, d.top);
        return;
      }
      if (!d.moved) {
        if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 4) return;
        d.moved = true; d.dialog.dataset.winDrag = ''; shut(false);
        // Out of a layout: its own size again, under the pointer at the same spot of the title bar.
        if (d.layout) {
          arrange(d.dialog, null, true);
          const n = d.dialog.getBoundingClientRect();
          const p = pullOut({ x: e.clientX, y: e.clientY }, d.grab, n, view);
          d.ox = num(d.dialog, '--win-x') + p.left - n.left; d.oy = num(d.dialog, '--win-y') + p.top - n.top;
          place(d.dialog, d.ox, d.oy);
          Object.assign(d, { x: e.clientX, y: e.clientY, left: p.left, top: p.top, width: n.width, layout: null });
        }
      }
      // The window stays inside the screen sideways (its buttons never leave it) and its title bar never goes above
      // the top edge or below the bottom one.
      const room = view.width - d.width - 16;
      const dx = room > 0 ? Math.min(8 + room - d.left, Math.max(8 - d.left, e.clientX - d.x)) : 0;
      const dy = Math.min(view.height - 64 - d.top, Math.max(8 - d.top, e.clientY - d.y));
      place(d.dialog, d.ox + dx, d.oy + dy);
      // Against an edge or in a corner: letting go puts it in that layout (only windows with buttons have layouts).
      if (d.dialog.dataset.win !== undefined) {
        const to = snapAt(e.clientX, e.clientY, view.width, view.height);
        if (to) d.dialog.dataset.winSnap = to; else delete d.dialog.dataset.winSnap;
        preview(d.dialog, to);
      }
    };
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      try { d.el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (d.kind === 'size') { delete d.dialog.dataset.winResize; return; }
      delete d.dialog.dataset.winDrag;
      const to = d.dialog.dataset.winSnap;
      delete d.dialog.dataset.winSnap; preview(null, null);
      // Its own place stays the one it had before this drag.
      if (isLayout(to)) { place(d.dialog, d.ox, d.oy); arrange(d.dialog, to); }
    };
    const twice = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || !wide()) return;
      const grip = target.closest<HTMLElement>('.modal__dialog[data-win] > [data-win-grip]');
      if (grip) { reset(grip.parentElement!); return; }
      const header = target.closest<HTMLElement>('.modal__header');
      if (!header || target.closest(CONTROL)) return;
      const dialog = header.closest<HTMLElement>('.modal__dialog');
      if (dialog?.dataset.win !== undefined && dialog.dataset.winMin === undefined) arrange(dialog, layoutOf(dialog) === 'max' ? null : 'max');
    };
    // A right click on the title bar opens the layout menu at the pointer.
    const context = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const header = target?.closest<HTMLElement>('.modal__header');
      if (!header || !wide() || target!.closest(CONTROL)) return;
      const dialog = header.closest<HTMLElement>('.modal__dialog');
      if (dialog?.dataset.win === undefined || dialog.dataset.winMin !== undefined) return;
      e.preventDefault();
      open(dialog, { x: e.clientX, y: e.clientY }, null);
    };
    // A press anywhere but in the menu (or on its button, which toggles it) closes the menu.
    const outside = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (menu && !(target && (menu.el.contains(target) || target.closest('[data-win-act="layout"]')))) shut(false);
    };
    const resized = () => { for (const d of document.querySelectorAll<HTMLElement>(DIALOG)) fit(d); };
    const early = { capture: true } as const;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown'] as const) window.addEventListener(type, back, early);
    window.addEventListener('keydown', keys, early);
    document.addEventListener('focusin', roam);
    document.addEventListener('pointerdown', outside, early);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('dblclick', twice);
    document.addEventListener('contextmenu', context);
    window.addEventListener('resize', resized);
    return () => {
      seen.disconnect(); cancelAnimationFrame(stray); shut(false); preview(null, null);
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown'] as const) window.removeEventListener(type, back, early);
      window.removeEventListener('keydown', keys, early);
      document.removeEventListener('focusin', roam); document.body.removeAttribute('data-react-aria-top-layer');
      document.removeEventListener('pointerdown', outside, early);
      document.removeEventListener('pointerdown', down); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up); document.removeEventListener('dblclick', twice); document.removeEventListener('contextmenu', context);
      window.removeEventListener('resize', resized);
    };
  }, []);
  return null;
}
