// Abuse checks: a real TCP probe against a local listener, and the CPU percentage of a VM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { cpuPct, probe } from '../abuse.mjs';

test('probe finds an open port and a closed one', async () => {
  const srv = createServer((s) => s.end()).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  assert.equal(await probe('127.0.0.1', port, 1000), true);
  srv.close();
  await new Promise((r) => srv.once('close', r));
  assert.equal(await probe('127.0.0.1', port, 1000), false);
});

test('CPU percentage of a VM from host MHz', () => {
  assert.equal(cpuPct(4000, 2, 2000), 100);
  assert.equal(cpuPct(1000, 2, 2000), 25);
  assert.equal(cpuPct(1000, 0, 2000), null);
});
