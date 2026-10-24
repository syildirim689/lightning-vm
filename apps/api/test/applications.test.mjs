// The installation script cloud-init runs: placeholders filled, the application script kept verbatim
// (a quoted here-document), and valid sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const { renderInstall, defaultScripts, tokenHash } = await import('../dist/application-scripts.js');

test('the rendered script fills in licence, host name and IP and reports back with the token', () => {
  const out = renderInstall({ name: 'Plesk', script: defaultScripts.plesk }, { license: 'A00B00-KEY1', hostname: 'web-1.example.com', ip: '203.0.113.10' },
    'https://panel.example.com/api/servers/s1/app-callback', 'tok_123');
  assert.match(out, /plesk bin license --install A00B00-KEY1/);
  assert.match(out, /hostnamectl set-hostname web-1\.example\.com/);
  assert.match(out, /'https:\/\/panel\.example\.com\/api\/servers\/s1\/app-callback'/);
  assert.match(out, /\\"token\\":\\"tok_123\\"/);
  assert.match(out, /<<'LVM_APP_EOF'\n[\s\S]*\nLVM_APP_EOF\n/);
  assert.ok(!out.includes('{LICENSE}') && !out.includes('{HOSTNAME}') && !out.includes('{IP}'));
  const sh = spawnSync('sh', ['-n'], { input: out });
  if (!sh.error) assert.equal(sh.status, 0, String(sh.stderr));
  assert.equal(tokenHash('tok_123').length, 64);
});

test('a custom script with $variables is not expanded by the wrapper', () => {
  const out = renderInstall({ name: 'X', script: 'echo "$HOME" > /tmp/x\n' }, { license: '', hostname: 'h', ip: '1.2.3.4' }, 'https://p/x', 't');
  assert.match(out, /\necho "\$HOME" > \/tmp\/x\n/);
});
