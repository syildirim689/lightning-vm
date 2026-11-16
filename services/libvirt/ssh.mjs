// How the adapter reaches a KVM host: the OpenSSH client that ships in its image, one short session per script.
// The host is trusted by the SHA-256 of its host key, pinned in the connection exactly where the other platforms
// pin a certificate ("pinned" mode); a key nobody pinned is answered with TLS_UNTRUSTED and the fingerprint, so
// the panel's "trust this certificate" dialog works here too. The connection's password is either a password
// (sshpass) or, when it starts with -----BEGIN, a private key. Failures become the adapter contract's codes
// (docs/adapter-contract.md). No npm dependencies.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net, { BlockList, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class Failure extends Error {
  constructor(code, message, extra) { super(message ?? code); this.code = code; Object.assign(this, extra); }
}

// Addresses the adapter never talks to (it sits on the panel's own network): loopback, link-local, unspecified
// and multicast, unless LIBVIRT_ALLOW_NETWORKS (comma-separated CIDRs) says otherwise.
const blocked = new BlockList();
for (const [addr, bits, family] of [['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['0.0.0.0', 8, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['::1', 128, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'], ['::', 128, 'ipv6']]) blocked.addSubnet(addr, bits, family);
const allowed = new BlockList();
for (const cidr of (process.env.LIBVIRT_ALLOW_NETWORKS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
  const [addr, bits] = cidr.split('/');
  if (isIP(addr)) allowed.addSubnet(addr, Number(bits ?? (isIP(addr) === 4 ? 32 : 128)), isIP(addr) === 4 ? 'ipv4' : 'ipv6');
}
export async function guardedAddress(host) {
  const list = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => { throw new Failure('DNS_FAILED', `cannot resolve ${host}`); });
  for (const a of list) {
    const family = a.family === 6 ? 'ipv6' : 'ipv4';
    if (blocked.check(a.address, family) && !allowed.check(a.address, family)) throw new Failure('ENDPOINT_BLOCKED', 'endpoint address is not permitted');
  }
  return list[0].address;
}

// One program, its input on stdin, its output collected. code -1: could not start; -2: killed (it ran too long).
const run = (cmd, args, { env = {}, input = '', timeout = 30000 } = {}) => new Promise((resolve) => {
  let p;
  try { p = spawn(cmd, args, { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e?.message ?? e) }); }
  const out = [], err = []; let size = 0, done = false;
  const end = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
  const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
  p.stdout.on('data', (c) => { size += c.length; if (size <= 16 * 1024 * 1024) out.push(c); });
  p.stderr.on('data', (c) => { if (err.length < 64) err.push(c); });
  p.on('error', (e) => end({ code: -1, stdout: '', stderr: String(e?.message ?? e) }));
  p.on('close', (code, signal) => end({ code: signal ? -2 : code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  p.stdin.on('error', () => { /* the program went away before reading everything */ });
  p.stdin.end(input);
});
// Whether anything listens there at all (asked only when no host key came back).
const probe = (address, port) => new Promise((resolve) => {
  const s = net.connect({ host: address, port, timeout: 6000 });
  s.on('connect', () => { s.destroy(); resolve('open'); });
  s.on('timeout', () => { s.destroy(); resolve('timeout'); });
  s.on('error', (e) => resolve(e?.code === 'ECONNREFUSED' ? 'refused' : 'timeout'));
});
const real = { run, probe };

const TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'];
// What ssh-keyscan printed: one host key per line ("host type base64"), the strongest kind first.
export function hostKeys(text) {
  const keys = [];
  for (const line of String(text).split('\n')) {
    const [, type, blob] = line.trim().split(/\s+/);
    if (!TYPES.includes(type) || !/^[A-Za-z0-9+/=]+$/.test(blob ?? '')) continue;
    keys.push({ type, blob, sha256: createHash('sha256').update(Buffer.from(blob, 'base64')).digest('hex') });
  }
  return keys.sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type));
}
// The host key in the shape the panel shows a certificate in.
const presented = (key, host, address) => ({ subject: `SSH host key (${key.type})`, issuer: 'SSH', notAfter: null, sha256: key.sha256, dnsNames: isIP(host) ? [] : [host], ips: [address], pem: '' });

// The records a script printed: the lines between LVMBEGIN and LVMOK, split at tabs. "LVMERR <CODE> <text>" is
// the script's own failure. (Anything a login script printed before LVMBEGIN is dropped.)
export function parse(stdout) {
  let lines = String(stdout).split('\n').map((l) => l.replace(/\r$/, ''));
  const begin = lines.lastIndexOf('LVMBEGIN');
  if (begin >= 0) lines = lines.slice(begin + 1);
  const failed = lines.find((l) => l.startsWith('LVMERR '));
  if (failed) { const [, code, ...text] = failed.split(' '); throw new Failure(/^[A-Z_]+$/.test(code) ? code : 'LIBVIRT_ERROR', text.join(' ')); }
  const ok = lines.indexOf('LVMOK');
  if (ok < 0) return null;
  return lines.slice(0, ok).filter(Boolean).map((l) => l.split('\t'));
}
// A private key as OpenSSH wants it. A key pasted into a one-line field arrives with its line breaks gone (or turned
// into spaces): the body is wrapped again. null: not a key this adapter can use (one with a passphrase, for one).
export function privateKey(text) {
  const m = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/.exec(String(text));
  if (!m) return null;
  const body = m[2].replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) return null;
  return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,70}/g).join('\n')}\n-----END ${m[1]}-----\n`;
}
// What an ssh that gave no result means.
export function sshFailure(r) {
  const text = String(r.stderr ?? '').trim(), line = text.split('\n').filter(Boolean).pop() ?? '';
  if (r.code === -1) return new Failure('LIBVIRT_ERROR', `the SSH client could not be started: ${line}`);
  if (r.code === 5 || /Permission denied|Too many authentication failures|Authentication failed/i.test(text)) return new Failure('INVALID_LOGIN', 'the host did not accept this user name with this password or key');
  if (r.code === 6 || /Host key verification failed|HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(text)) return new Failure('TLS_UNTRUSTED', 'the host key is not the pinned one');
  if (/Connection refused/i.test(text)) return new Failure('CONNECTION_REFUSED', line);
  if (r.code === -2 || /timed out|Connection timeout/i.test(text)) return new Failure('TIMEOUT', 'timed out');
  if (/bash: (command )?not found|bash: No such file/i.test(text)) return new Failure('NOT_LIBVIRT', 'bash is not installed on this host');
  return new Failure('LIBVIRT_ERROR', line || `the script ended without a result (ssh exit ${r.code})`);
}

// Opens nothing yet: checks the host key, writes it (and a private key) into a private folder, and returns the
// function that runs one script on the host. close() removes the folder.
export async function connect(target, options = {}) {
  const t = options.transport ?? real;
  const host = String(target?.host ?? '').trim(), port = Number(target?.port) || 22, user = String(target?.username ?? ''), secret = String(target?.password ?? '');
  if (!host || !user || !secret) throw new Failure('INVALID_REQUEST', 'host, username and password are required');
  if (!/^[A-Za-z_][\w.@-]{0,63}$/.test(user)) throw new Failure('INVALID_REQUEST', 'the user name has characters SSH does not accept here');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Failure('INVALID_REQUEST', 'port must be 1 to 65535');
  const mode = target?.tls?.mode || 'system';
  if (!['system', 'ca', 'pinned'].includes(mode)) throw new Failure('INVALID_TLS_MODE', `unknown TLS mode ${mode}`);
  const pin = String(target?.tls?.sha256 ?? '').replace(/:/g, '').toLowerCase();
  if (mode === 'pinned' && !/^[0-9a-f]{64}$/.test(pin)) throw new Failure('INVALID_PIN', 'the fingerprint must be 64 hex characters');
  const address = await guardedAddress(host);

  const scan = await t.run('ssh-keyscan', ['-T', '8', '-p', String(port), '-t', 'ed25519,ecdsa,rsa', address], { timeout: 15000 });
  const keys = hostKeys(scan.stdout);
  if (!keys.length) {
    if (scan.code === -1) throw new Failure('LIBVIRT_ERROR', 'ssh-keyscan is not in the adapter image');
    const state = await t.probe(address, port);
    if (state === 'refused') throw new Failure('CONNECTION_REFUSED', `nothing listens on port ${port}`);
    if (state === 'timeout') throw new Failure('TIMEOUT', 'timed out');
    throw new Failure('NOT_LIBVIRT', `no SSH server answered on port ${port}`);
  }
  const key = mode === 'pinned' ? keys.find((k) => k.sha256 === pin) : null;
  if (!key) throw new Failure('TLS_UNTRUSTED', mode === 'pinned' ? 'the host key is not the pinned one' : 'an SSH host is trusted by the fingerprint of its host key', { certificate: presented(keys[0], host, address) });

  const dir = await mkdtemp(join(tmpdir(), 'lvm-ssh-'));
  const known = join(dir, 'known_hosts'), identity = join(dir, 'id');
  const isKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(secret), pem = isKey ? privateKey(secret) : null;
  if (isKey && !pem) throw new Failure('INVALID_LOGIN', 'the private key could not be read (a key with a passphrase cannot be used)');
  try {
    await writeFile(known, `${port === 22 ? address : `[${address}]:${port}`} ${key.type} ${key.blob}\n`, { mode: 0o600 });
    if (isKey) await writeFile(identity, pem, { mode: 0o600 });
  } catch (e) { await rm(dir, { recursive: true, force: true }); throw new Failure('LIBVIRT_ERROR', `the adapter cannot write its temporary files: ${e?.message ?? e}`); }
  const args = ['-F', '/dev/null', '-T', '-p', String(port), '-l', user, '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${known}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', `HostKeyAlgorithms=${key.type === 'ssh-rsa' ? 'rsa-sha2-512,rsa-sha2-256,ssh-rsa' : key.type}`, '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'LogLevel=ERROR', '-o', 'IdentitiesOnly=yes',
    ...(isKey ? ['-i', identity, '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey'] : ['-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1']),
    address, 'bash -s'];

  const sh = async (text, { timeout = 50000 } = {}) => {
    const r = isKey ? await t.run('ssh', args, { input: `echo LVMBEGIN\n${text}`, timeout }) : await t.run('sshpass', ['-e', 'ssh', ...args], { env: { SSHPASS: secret }, input: `echo LVMBEGIN\n${text}`, timeout });
    const rows = parse(r.stdout); // throws the script's own failure
    if (!rows) throw sshFailure(r);
    return rows;
  };
  sh.close = () => { rm(dir, { recursive: true, force: true }).catch(() => {}); };
  return sh;
}
