// The connection check's rules (run with: node --test lib/*.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { allows, bare, loginPort, toolsCommand, usesAddress } from './connect.ts';

test('the login port follows the guest OS', () => {
  assert.equal(loginPort('Microsoft Windows Server 2022 (64-bit)'), 3389);
  assert.equal(loginPort('windowsGuest'), 3389);
  assert.equal(loginPort('Ubuntu Linux (64-bit)'), 22);
  assert.equal(loginPort(''), 22);
});

test('inbound TCP rules open a port by number, range or "all"', () => {
  assert.equal(allows([{ direction: 'in', protocol: 'tcp', port: '22' }], 22), true);
  assert.equal(allows([{ direction: 'in', protocol: 'tcp', port: '20-30' }], 22), true);
  assert.equal(allows([{ direction: 'in', protocol: 'tcp', port: null }], 3389), true);
  assert.equal(allows([{ direction: 'in', protocol: 'tcp', port: '80' }], 22), false);
  assert.equal(allows([{ direction: 'out', protocol: 'tcp', port: '22' }], 22), false);
  assert.equal(allows([{ direction: 'in', protocol: 'udp', port: '22' }], 22), false);
  assert.equal(allows([], 22), false);
});

test('the guest address is compared without its prefix length', () => {
  assert.deepEqual(bare(['10.0.0.5/24', 'fe80::1']), ['10.0.0.5', 'fe80::1']);
  assert.equal(usesAddress(['10.0.0.5/24'], '10.0.0.5'), true);
  assert.equal(usesAddress(['192.168.1.9/24'], '10.0.0.5'), false);
  assert.equal(usesAddress([], '10.0.0.5'), true); // nothing reported: not a mismatch
  assert.equal(usesAddress(['10.0.0.5'], null), true);
});

test('the open-vm-tools command follows the distribution', () => {
  assert.match(toolsCommand('Ubuntu Linux (64-bit)')!, /^sudo apt-get/);
  assert.match(toolsCommand('Debian GNU/Linux 12 (64-bit)')!, /apt-get/);
  assert.match(toolsCommand('Rocky Linux (64-bit)')!, /dnf .* vmtoolsd$/);
  assert.match(toolsCommand('Red Hat Enterprise Linux 9 (64-bit)')!, /dnf/);
  assert.match(toolsCommand('SUSE Linux Enterprise 15 (64-bit)')!, /zypper/);
  assert.match(toolsCommand('Alpine 3.20')!, /^apk/);
  assert.equal(toolsCommand('Microsoft Windows Server 2022 (64-bit)'), null);
  assert.equal(toolsCommand('Other 5.x Linux (64-bit)'), null);
});
