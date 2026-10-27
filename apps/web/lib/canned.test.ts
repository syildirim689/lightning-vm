import test from 'node:test';
import assert from 'node:assert/strict';
import { fillCanned } from './canned.ts';

test('canned reply placeholders are filled; empty or unknown ones stay', () => {
  assert.equal(fillCanned('Hi {name}, about {ticket} on {server}.', { name: 'Ada', ticket: '#1001', server: 'web-1' }), 'Hi Ada, about #1001 on web-1.');
  assert.equal(fillCanned('{server} {other} {name}{name}', { name: 'A', ticket: '', server: '' }), '{server} {other} AA');
});
