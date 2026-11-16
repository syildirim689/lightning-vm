// The update reporter on a new server's first boot (cloud-init).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudInit, updatesInstaller } from '../operations.mjs';

const server = { id: '8f0c0d2e-5b7a-4c1e-9d3f-2a6b7c8d9e0f', name: 'web1', address: '203.0.113.20', prefix: 24, gateway: '203.0.113.1', dns: ['1.1.1.1'], ssh_public_keys: [], image_family: 'linux' };
const userdata = (s) => JSON.parse(cloudInit(s).userdata.replace('#cloud-config\n', ''));

test('the installer downloads the reporter from the panel and hands it the server and its token', () => {
  const sh = updatesInstaller('https://panel.example', server.id, 'tok_en-1');
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.ok(sh.includes("curl -fsSL -m 30 'https://panel.example/api/guest/updates.sh' -o /root/lightning-updates.sh"));
  assert.ok(sh.includes(`sh /root/lightning-updates.sh 'https://panel.example' '${server.id}' 'tok_en-1'`));
  assert.ok(sh.includes('rm -f /root/lightning-updates.sh /root/lightning-updates-install.sh'), 'the token does not stay in /root');
});

test('a server without an application or update tracking gets no commands', () => {
  const u = userdata(server);
  assert.equal(u.runcmd, undefined);
  assert.equal(u.write_files, undefined);
});

test('a copy without update tracking forgets the reporter settings of the server it was copied from', () => {
  assert.deepEqual(userdata({ ...server, clone_from_moref: 'vm-12' }).runcmd, [['sh', '-c', 'rm -f /etc/lightning-updates.conf']]);
});
