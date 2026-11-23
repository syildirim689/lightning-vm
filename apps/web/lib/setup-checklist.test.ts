import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checklistShown, openKeys, parseHidden, reopenedBy, type SetupStep } from './setup-checklist.ts';

const step = (key: string, done: boolean, group: SetupStep['group'] = 'health'): SetupStep => ({ key, group, done, link: '/admin' });

test('all done: nothing to show', () => {
  assert.equal(checklistShown([step('mail', true), step('backup', true)], null), false);
});

test('an open step shows the list until it is put away', () => {
  const s = [step('mail', true), step('monitoring', false)];
  assert.equal(checklistShown(s, null), true);
  assert.equal(checklistShown(s, ['monitoring']), false);
});

test('put away, it comes back when something that was fine breaks or a new step appears', () => {
  const hidden = ['monitoring'];
  const regressed = [step('mailDelivers', false), step('monitoring', false)];
  assert.equal(checklistShown(regressed, hidden), true);
  assert.deepEqual(reopenedBy(regressed, hidden), ['mailDelivers']);
  assert.deepEqual(reopenedBy(regressed, null), []);
});

test('fixing a step while it is put away keeps it away', () => {
  assert.equal(checklistShown([step('monitoring', true), step('updates', false)], ['monitoring', 'updates']), false);
  assert.deepEqual(openKeys([step('monitoring', true), step('updates', false)]), ['updates']);
});

test('whatever is in storage is read as data', () => {
  assert.deepEqual(parseHidden('["a","b"]'), ['a', 'b']);
  for (const bad of [null, undefined, '', 'nope', '{"a":1}', '[1,2]']) assert.equal(parseHidden(bad), null, String(bad));
});
