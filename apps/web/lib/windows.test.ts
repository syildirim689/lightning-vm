import test from 'node:test';
import assert from 'node:assert/strict';
import { clampSize, keyAction, keyHints, layoutRect, layouts, menuStep, pullOut, snapAt } from './windows.ts';

test('layouts leave 8 px to the edges and between halves', () => {
  assert.deepEqual(layoutRect('left', 1280, 720), { x: 8, y: 8, width: 628, height: 704 });
  assert.deepEqual(layoutRect('right', 1280, 720), { x: 644, y: 8, width: 628, height: 704 });
  assert.deepEqual(layoutRect('max', 1280, 720), { x: 8, y: 8, width: 1264, height: 704 });
  assert.deepEqual(layoutRect('bottom', 1280, 720), { x: 8, y: 364, width: 1264, height: 348 });
  assert.deepEqual(layoutRect('br', 1280, 720), { x: 644, y: 364, width: 628, height: 348 });
  // Two halves side by side: the gap between them is 8 px too.
  const l = layoutRect('tl', 1000, 800), r = layoutRect('tr', 1000, 800);
  assert.equal(r.x - (l.x + l.width), 8);
  assert.equal(layouts.length, 9);
});

test('a drag let go at an edge or corner means a layout', () => {
  const at = (x: number, y: number) => snapAt(x, y, 1280, 720);
  assert.equal(at(640, 0), 'max');
  assert.equal(at(0, 360), 'left');
  assert.equal(at(1279, 360), 'right');
  assert.equal(at(0, 10), 'tl');
  assert.equal(at(10, 0), 'tl');
  assert.equal(at(1279, 0), 'tr');
  assert.equal(at(1279, 700), 'br');
  assert.equal(at(0, 719), 'bl');
  assert.equal(at(640, 719), null); // the bottom edge alone: nothing
  assert.equal(at(640, 360), null);
  assert.equal(at(7, 360), null); // just off the edge
});

test('a resized window stays between its minimum and the screen', () => {
  const view = { width: 1280, height: 720 };
  assert.deepEqual(clampSize({ width: 500, height: 400 }, { left: 100, top: 100 }, view), { width: 500, height: 400 });
  assert.deepEqual(clampSize({ width: 100, height: 50 }, { left: 100, top: 100 }, view), { width: 320, height: 200 });
  assert.deepEqual(clampSize({ width: 5000, height: 5000 }, { left: 100, top: 100 }, view), { width: 1172, height: 612 });
  // Less room than the minimum: the screen wins.
  assert.deepEqual(clampSize({ width: 400, height: 400 }, { left: 1100, top: 600 }, view), { width: 172, height: 112 });
});

test('pulled out of a layout, a window keeps its place under the pointer', () => {
  const view = { width: 1280, height: 720 };
  // Grabbed at 25 % of the bar, 20 px down: the 480 px window has 120 px left of the pointer.
  assert.deepEqual(pullOut({ x: 900, y: 300 }, { fx: 0.25, dy: 20 }, { width: 480, height: 400 }, view), { left: 780, top: 280 });
  // Near the right edge it stays on the screen.
  assert.deepEqual(pullOut({ x: 1270, y: 30 }, { fx: 0.1, dy: 40 }, { width: 480, height: 400 }, view), { left: 792, top: 8 });
  // Near the left edge too.
  assert.deepEqual(pullOut({ x: 10, y: 300 }, { fx: 0.9, dy: 10 }, { width: 480, height: 400 }, view), { left: 8, top: 290 });
});

test('keys: Ctrl+Alt with an arrow or C, nothing else', () => {
  const k = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
    keyAction({ ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, code, ...mods });
  assert.equal(k('ArrowLeft'), 'left');
  assert.equal(k('ArrowRight'), 'right');
  assert.equal(k('ArrowUp'), 'max');
  assert.equal(k('ArrowDown'), 'restore');
  assert.equal(k('KeyC'), 'centre');
  assert.equal(k('KeyX'), null);
  assert.equal(k('ArrowLeft', { altKey: false }), null); // Ctrl+← moves by a word
  assert.equal(k('ArrowLeft', { shiftKey: true }), null); // Ctrl+Shift+← selects a word
  assert.equal(k('ArrowLeft', { metaKey: true }), null);
  assert.equal(keyHints(false).left, 'Ctrl+Alt+←');
  assert.equal(keyHints(true).centre, '⌃⌥C');
});

test('the layout menu: a 3 × 3 grid, then a list', () => {
  const n = 13; // nine layouts and four text items
  assert.equal(menuStep(0, 'ArrowRight', n), 1);
  assert.equal(menuStep(0, 'ArrowLeft', n), 12);
  assert.equal(menuStep(1, 'ArrowDown', n), 4);
  assert.equal(menuStep(7, 'ArrowDown', n), 9); // bottom row → first text item
  assert.equal(menuStep(9, 'ArrowUp', n), 6); // first text item → bottom row
  assert.equal(menuStep(9, 'ArrowDown', n), 10);
  assert.equal(menuStep(12, 'ArrowDown', n), 0);
  assert.equal(menuStep(1, 'ArrowUp', n), 12);
  assert.equal(menuStep(5, 'Home', n), 0);
  assert.equal(menuStep(5, 'End', n), 12);
});
