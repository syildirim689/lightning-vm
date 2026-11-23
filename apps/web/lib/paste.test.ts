import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSshKey, repairPaste, sshKeyInfo } from './formats.ts';

// Real-shaped key blobs: length-prefixed fields, as ssh-keygen writes them.
const field = (b: Buffer) => { const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return Buffer.concat([n, b]); };
const blob = (...parts: Buffer[]) => Buffer.concat(parts.map(field)).toString('base64');
const ed = blob(Buffer.from('ssh-ed25519'), Buffer.alloc(32, 7));
const rsa = blob(Buffer.from('ssh-rsa'), Buffer.from([1, 0, 1]), Buffer.concat([Buffer.from([0]), Buffer.alloc(256, 0xc3)]));
const ecdsa = blob(Buffer.from('ecdsa-sha2-nistp256'), Buffer.from('nistp256'), Buffer.alloc(65, 4));
const edKey = `ssh-ed25519 ${ed} serhat@laptop`;

test('a good key says its type, size and comment', () => {
  assert.ok(isSshKey(edKey));
  assert.deepEqual(sshKeyInfo(edKey), { ok: true, type: 'ED25519', bits: 256, comment: 'serhat@laptop' });
  assert.deepEqual(sshKeyInfo(`ssh-rsa ${rsa}`), { ok: true, type: 'RSA', bits: 2048, comment: '' });
  assert.deepEqual(sshKeyInfo(`ecdsa-sha2-nistp256 ${ecdsa} ci`), { ok: true, type: 'ECDSA', bits: 256, comment: 'ci' });
  assert.equal(sshKeyInfo('   '), null);
});

test('what cannot be used says why, a private key first of all', () => {
  const table: [string, string][] = [
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', 'private'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'private'],
    ['PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none', 'putty'],
    [`---- BEGIN SSH2 PUBLIC KEY ----\n${ed}\n---- END SSH2 PUBLIC KEY ----`, 'ssh2'],
    [`sk-ssh-ed25519@openssh.com ${ed} yubikey`, 'sk'],
    [`ssh-dss ${ed} old`, 'dss'],
    [`ssh-rsa ${ed} wrong-type`, 'mismatch'],
    [`ssh-ed25519 ${ed.slice(0, -8)} cut`, 'mismatch'],
    ['hello world', 'unknown'],
  ];
  for (const [input, problem] of table) assert.deepEqual(sshKeyInfo(input), { ok: false, problem }, input.slice(0, 30));
});

test('a key broken over several lines is joined where its blob ends, and the comment stays', () => {
  const wrapped = `ssh-ed25519 ${ed.slice(0, 30)}\n${ed.slice(30)}\nserhat@laptop\n`;
  assert.equal(repairPaste('sshKey', wrapped), edKey);
  // A comment that looks like base64 is not swallowed into the key.
  assert.equal(repairPaste('sshKey', `ssh-ed25519 ${ed.slice(0, 20)}\n${ed.slice(20)} laptop`), `ssh-ed25519 ${ed} laptop`);
  assert.equal(repairPaste('sshKey', edKey), null, 'a key on one line is pasted as it is');
});

test('the RFC 4716 form (PuTTYgen, ssh-keygen -e) becomes the one-line OpenSSH form', () => {
  const ssh2 = `---- BEGIN SSH2 PUBLIC KEY ----\r\nComment: "rsa-key-20261123 \\\r\nwork"\r\n${rsa.slice(0, 64)}\r\n${rsa.slice(64)}\r\n---- END SSH2 PUBLIC KEY ----\r\n`;
  assert.equal(repairPaste('sshKey', ssh2), `ssh-rsa ${rsa} rsa-key-20261123 work`);
  assert.equal(repairPaste('sshKey', `---- BEGIN SSH2 PUBLIC KEY ----\n${ed}\n---- END SSH2 PUBLIC KEY ----`), `ssh-ed25519 ${ed}`);
  assert.equal(repairPaste('sshKey', '---- BEGIN SSH2 PUBLIC KEY ----\nnot base64!\n---- END SSH2 PUBLIC KEY ----'), null);
});

test('a list pasted one per line into a one-line field keeps every entry apart', () => {
  assert.equal(repairPaste('ipOrCidr', '10.0.0.1\n10.0.0.0/24\r\n\n 192.168.1.5 \n', { list: true }), '10.0.0.1, 10.0.0.0/24, 192.168.1.5');
  assert.equal(repairPaste('ipOrCidr', '10.0.0.1, 10.0.0.2', { list: true }), null, 'one line: as typed');
  assert.equal(repairPaste('ipOrCidr', '10.0.0.1\n10.0.0.2', { list: true, multiline: true }), null, 'a multi-line field keeps the lines');
  assert.equal(repairPaste('ipOrCidr', '10.0.0.1\n10.0.0.2'), null, 'not a list field');
  assert.equal(repairPaste(undefined, 'a\nb', { list: true }), 'a, b');
});
