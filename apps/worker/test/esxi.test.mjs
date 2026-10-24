// Nested ESXi: the vApp properties the appliance reads on first boot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { esxiProperties } from '../operations.mjs';

test('network settings become ESXi appliance properties; the netmask is dotted', () => {
  const p = esxiProperties({ name: 'esx1', address: '203.0.113.20', prefix: 26, gateway: '203.0.113.1', dns: ['1.1.1.1', '8.8.8.8'], root_password_enc: null });
  assert.equal(p['guestinfo.hostname'], 'esx1');
  assert.equal(p['guestinfo.netmask'], '255.255.255.192');
  assert.equal(p['guestinfo.dns'], '1.1.1.1,8.8.8.8');
  assert.equal(p['guestinfo.ssh'], 'True');
  assert.equal(p['guestinfo.password'], '');
  assert.equal(esxiProperties({ name: 'x', prefix: 24 })['guestinfo.netmask'], '255.255.255.0');
  assert.equal(esxiProperties({ name: 'x', prefix: 16 })['guestinfo.netmask'], '255.255.0.0');
});
