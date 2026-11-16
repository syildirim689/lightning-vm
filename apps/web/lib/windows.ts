// The arithmetic behind the dialog windows (components/window-chrome.tsx): where a window lands when it is let go
// near an edge, how far it may be resized, where it goes when pulled out of a layout, and what the keys mean.
// The DOM work stays in the component; the layouts themselves are drawn by style.css with the same numbers.

// A layout puts the window on a fixed part of the screen. The order is the menu's 3 × 3 grid, row by row.
export const layouts = ['tl', 'top', 'tr', 'left', 'max', 'right', 'bl', 'bottom', 'br'] as const;
export type Layout = (typeof layouts)[number];
export const isLayout = (v: unknown): v is Layout => typeof v === 'string' && (layouts as readonly string[]).includes(v);

// The part of the screen each layout covers, as fractions [x, y, width, height] (also drawn as the menu's icons).
export const areas: Record<Layout, readonly [number, number, number, number]> = {
  tl: [0, 0, 0.5, 0.5], top: [0, 0, 1, 0.5], tr: [0.5, 0, 0.5, 0.5],
  left: [0, 0, 0.5, 1], max: [0, 0, 1, 1], right: [0.5, 0, 0.5, 1],
  bl: [0, 0.5, 0.5, 0.5], bottom: [0, 0.5, 1, 0.5], br: [0.5, 0.5, 0.5, 0.5],
};
export const GAP = 8; // px to the screen edges and between two windows side by side

export type Rect = { x: number; y: number; width: number; height: number };
// The rectangle a layout covers on a w × h screen: 8 px from every edge, 8 px between halves. style.css draws the
// same with calc(); this is what the tests check against.
export function layoutRect(l: Layout, w: number, h: number, gap = GAP): Rect {
  const [fx, fy, fw, fh] = areas[l];
  return { x: gap + fx * (w - gap), y: gap + fy * (h - gap), width: fw * (w - gap) - gap, height: fh * (h - gap) - gap };
}

// Where a dragged window would land if let go with the pointer at (x, y) on a w × h screen; null: where it is.
// Against the left or right edge it takes that half, the top edge makes it large; near a corner (on either of its
// two edges) it takes that quarter. The bottom edge alone means nothing: the title bar can never get there.
export function snapAt(x: number, y: number, w: number, h: number, edge = 6, corner = 96): Layout | null {
  const atLeft = x <= edge, atRight = x >= w - 1 - edge, atTop = y <= edge, atBottom = y >= h - 1 - edge;
  const nearTop = y < corner, nearBottom = y > h - 1 - corner, nearLeft = x < corner, nearRight = x > w - 1 - corner;
  if (atLeft || atRight) return nearTop ? (atLeft ? 'tl' : 'tr') : nearBottom ? (atLeft ? 'bl' : 'br') : atLeft ? 'left' : 'right';
  if (atTop) return nearLeft ? 'tl' : nearRight ? 'tr' : 'max';
  if (atBottom) return nearLeft ? 'bl' : nearRight ? 'br' : null;
  return null;
}

// A size dragged on the resize edges. At least min (a window narrower than its title bar's buttons is no use), at
// most what is left of the screen to the right of and below the window's top-left corner; when the screen is
// smaller than the minimum, the screen wins.
export const MIN = { width: 320, height: 200 } as const;
export function clampSize(want: { width: number; height: number }, at: { left: number; top: number }, view: { width: number; height: number }, min: { width: number; height: number } = MIN, gap = GAP) {
  const roomW = Math.max(0, view.width - at.left - gap), roomH = Math.max(0, view.height - at.top - gap);
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(Math.min(lo, hi), Math.min(hi, Math.max(lo, v))));
  return { width: clamp(want.width, min.width, roomW), height: clamp(want.height, min.height, roomH) };
}

// Pulling a window out of a layout by its title bar: it gets its own size back, and the pointer keeps the same
// place across the bar (a grab at 30 % stays at 30 %) and the same height in it, so it does not jump away from the
// pointer. The box stays on the screen.
export function pullOut(pointer: { x: number; y: number }, grab: { fx: number; dy: number }, size: { width: number; height: number }, view: { width: number; height: number }, gap = GAP) {
  const left = pointer.x - grab.fx * size.width;
  const top = pointer.y - grab.dy;
  return {
    left: Math.round(size.width + 2 * gap > view.width ? gap : Math.min(view.width - gap - size.width, Math.max(gap, left))),
    top: Math.round(Math.max(gap, top)),
  };
}

// The keys on a focused window: Ctrl+Alt (⌃⌥ on a Mac) with an arrow or C. Read from e.code, not e.key: with Alt
// held a Mac (and AltGr on many Windows layouts) turns C into another letter. Returns null for anything else.
export type KeyAction = Layout | 'restore' | 'centre';
export function keyAction(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; code: string }): KeyAction | null {
  if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return null;
  return ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'max', ArrowDown: 'restore', KeyC: 'centre' } as const)[e.code as 'KeyC'] ?? null;
}
// How the keys are written in titles and the menu.
export const keyHints = (mac: boolean): Record<'left' | 'right' | 'max' | 'restore' | 'centre', string> => {
  const p = mac ? '⌃⌥' : 'Ctrl+Alt+';
  return { left: `${p}←`, right: `${p}→`, max: `${p}↑`, restore: `${p}↓`, centre: `${p}C` };
};

// Moving through the layout menu with the arrow keys: the nine layouts are a 3 × 3 grid (left/right/up/down move
// in it), the text items under it a list; Up from the first item goes into the grid's bottom row, Down from the
// grid's bottom row to the first item. Home/End jump to the ends; everything wraps around.
export function menuStep(index: number, key: string, count: number, cells = 9, cols = 3): number {
  const last = count - 1, wrap = (i: number) => (i + count) % count;
  switch (key) {
    case 'Home': return 0;
    case 'End': return last;
    case 'ArrowRight': return wrap(index + 1);
    case 'ArrowLeft': return wrap(index - 1);
    case 'ArrowDown': return index < cells ? (index + cols < cells ? index + cols : Math.min(cells, last)) : wrap(index + 1);
    case 'ArrowUp': return index < cells ? (index - cols >= 0 ? index - cols : last) : index === cells ? cells - cols : index - 1;
    default: return index;
  }
}
