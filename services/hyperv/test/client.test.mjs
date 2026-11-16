// The real client (TLS trust, NTLM or Basic sign-in, the WS-Management shell) against a local HTTPS server that
// plays WinRM. Needs the openssl command to make its certificate; without it the tests are skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HYPERV_ALLOW_NETWORKS = '127.0.0.0/8'; // read when winrm.mjs loads
const { connect, ntlmV2Hash } = await import('../winrm.mjs');

let key, cert;
try {
  const dir = mkdtempSync(join(tmpdir(), 'lvm-hv-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=hv.test', '-addext', 'subjectAltName=DNS:hv.test,IP:127.0.0.1',
    '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  key = readFileSync(join(dir, 'k.pem'), 'utf8'); cert = readFileSync(join(dir, 'c.pem'), 'utf8');
  rmSync(dir, { recursive: true, force: true });
} catch { /* no openssl */ }
const skip = !cert && 'openssl is not available';
const pin = cert ? createHash('sha256').update(new X509Certificate(cert).raw).digest('hex') : '';
const SERVER_CHALLENGE = Buffer.from('1122334455667788', 'hex');
const hmac = (k, ...p) => { const m = createHmac('md5', k); for (const x of p) m.update(x); return m.digest(); };

// The server checks the NTLMv2 answer itself (it knows the password), the way a real one does.
function ntlmOk(type3, user, domain, password) {
  const field = (i) => type3.subarray(type3.readUInt32LE(16 + i * 8), type3.readUInt32LE(16 + i * 8) + type3.readUInt16LE(12 + i * 8));
  const nt = field(1);
  return field(3).toString('utf16le') === user && nt.subarray(0, 16).equals(hmac(ntlmV2Hash(user, domain, password), SERVER_CHALLENGE, nt.subarray(16)));
}
// closeAfter: the host closes the connection after answering that action (as it does with an idle one), so the next request arrives on a new, unsigned socket.
async function fake({ offer = 'Negotiate', result = 'LVMOK {"hello":"dünya"}\r\n', exitCode = 0, stderr = '', closeAfter = '' } = {}) {
  const seen = { actions: [], stdin: Buffer.alloc(0), sockets: new Set(), signedIn: new WeakSet() };
  const server = https.createServer({ key, cert }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.sockets.add(req.socket);
      const auth = req.headers.authorization ?? '';
      const deny = (header) => { res.writeHead(401, header ? { 'www-authenticate': header } : {}); res.end(); };
      if (!seen.signedIn.has(req.socket)) {
        if (offer === 'Basic') {
          if (auth !== `Basic ${Buffer.from('administrator:right').toString('base64')}`) return deny('Basic realm="WSMAN"');
        } else {
          const token = /^Negotiate (.+)$/.exec(auth)?.[1];
          if (!token) return deny('Negotiate');
          const msg = Buffer.from(token, 'base64');
          if (msg.readUInt32LE(8) === 1) {
            const info = Buffer.concat([Buffer.from([2, 0, 6, 0]), Buffer.from('LAB', 'utf16le'), Buffer.alloc(4)]);
            const c = Buffer.alloc(56 + info.length); c.write('NTLMSSP\0', 0, 'latin1'); c.writeUInt32LE(2, 8); c.writeUInt32LE(0x00088207, 20); SERVER_CHALLENGE.copy(c, 24);
            c.writeUInt16LE(info.length, 40); c.writeUInt16LE(info.length, 42); c.writeUInt32LE(56, 44); info.copy(c, 56);
            return deny(`Negotiate ${c.toString('base64')}`);
          }
          if (!ntlmOk(msg, 'admin', 'LAB', 'right')) return deny('Negotiate');
        }
        seen.signedIn.add(req.socket);
      }
      const xml = Buffer.concat(chunks).toString();
      const action = /<a:Action[^>]*>([^<]+)</.exec(xml)[1].split('/').pop();
      seen.actions.push(action);
      const reply = (body) => { res.writeHead(200, { 'content-type': 'application/soap+xml', ...(action === closeAfter && { connection: 'close' }) }); res.end(`<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell"><s:Body>${body}</s:Body></s:Envelope>`); };
      if (action === 'Create') { seen.create = /<s:Body>(.*)<\/s:Body>/.exec(xml)[1]; return reply('<rsp:Shell><rsp:ShellId>SHELL-1</rsp:ShellId></rsp:Shell>'); }
      if (action === 'Command') { seen.command = [...xml.matchAll(/<rsp:Arguments>([^<]*)</g)].map((m) => m[1]); return reply('<rsp:CommandResponse><rsp:CommandId>CMD-1</rsp:CommandId></rsp:CommandResponse>'); }
      if (action === 'Send') { seen.stdin = Buffer.concat([seen.stdin, Buffer.from(/<rsp:Stream[^>]*>([^<]*)</.exec(xml)[1], 'base64')]); seen.ended = / End="true"/.test(xml); return reply('<rsp:SendResponse/>'); }
      if (action === 'Receive') {
        if (!seen.polled) { seen.polled = true; res.writeHead(500, { 'content-type': 'application/soap+xml' }); return res.end('<s:Envelope><s:Body><s:Fault><f:WSManFault Code="2150858793"/><s:Subcode><s:Value>w:TimedOut</s:Value></s:Subcode></s:Fault></s:Body></s:Envelope>'); }
        return reply(`<rsp:ReceiveResponse><rsp:Stream Name="stdout" CommandId="CMD-1">${Buffer.from(result).toString('base64')}</rsp:Stream><rsp:Stream Name="stderr" CommandId="CMD-1">${Buffer.from(stderr).toString('base64')}</rsp:Stream>`
          + `<rsp:CommandState CommandId="CMD-1" State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done"><rsp:ExitCode>${exitCode}</rsp:ExitCode></rsp:CommandState></rsp:ReceiveResponse>`);
      }
      reply('');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, seen };
}

test('NTLM signs the connection in once; the script goes in on standard input and its result comes back', { skip }, async () => {
  const { server, port, seen } = await fake();
  try {
    const ps = await connect({ host: '127.0.0.1', port, username: 'LAB\\admin', password: 'right', tls: { mode: 'pinned', sha256: pin } });
    const script = `Write-Output 'ünï €'\n${'# padding\n'.repeat(9000)}`; // longer than one Send
    assert.deepEqual(await ps(script), { hello: 'dünya' });
    assert.equal(seen.stdin.toString('utf8'), script, 'the whole script arrived, in order');
    assert.equal(seen.ended, true);
    assert.deepEqual(seen.actions.filter((a, i, l) => a !== l[i - 1]), ['Create', 'Command', 'Send', 'Receive', 'Delete'], 'a quiet Receive is asked again, and the shell is closed');
    assert.deepEqual(seen.command.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    assert.match(Buffer.from(seen.command[5], 'base64').toString('utf16le'), /ReadToEnd\(\);Invoke-Expression/);
    assert.equal(seen.sockets.size, 1, 'everything on the one signed-in connection');
    // The shell is asked to end itself when nobody uses it (MS-WSMV 2.2.4.37: IdleTimeOut, a duration, before the streams).
    assert.equal(seen.create, '<rsp:Shell><rsp:IdleTimeOut>PT180.000S</rsp:IdleTimeOut><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>');
    ps.close();
  } finally { server.close(); }
});

test('a connection the host closed in between is signed in again, not reported as a wrong password', { skip }, async () => {
  const { server, port, seen } = await fake({ closeAfter: 'Command' });
  try {
    const ps = await connect({ host: '127.0.0.1', port, username: 'LAB\\admin', password: 'right', tls: { mode: 'pinned', sha256: pin } });
    assert.deepEqual(await ps('x'), { hello: 'dünya' });
    assert.equal(seen.sockets.size, 2, 'the rest of the script went over a second connection');
    assert.deepEqual(seen.actions.filter((a, i, l) => a !== l[i - 1]), ['Create', 'Command', 'Send', 'Receive', 'Delete']);
    ps.close();
  } finally { server.close(); }
});

test('an address on one of this machine\'s own networks is refused before anything is sent', { skip }, async () => {
  const own = Object.values(networkInterfaces()).flat().find((a) => a && !a.internal && a.family === 'IPv4' && !a.address.startsWith('169.254.'));
  if (!own) return; // a machine with no network of its own has nothing to refuse
  await assert.rejects(connect({ host: own.address, username: 'administrator', password: 'x', tls: { mode: 'system' } }), { code: 'ENDPOINT_BLOCKED' });
});

test('a wrong password is INVALID_LOGIN; Basic is used where the host offers only that', { skip }, async () => {
  const a = await fake();
  try {
    const ps = await connect({ host: '127.0.0.1', port: a.port, username: 'LAB\\admin', password: 'wrong', tls: { mode: 'ca', caPem: cert } });
    await assert.rejects(ps('x'), { code: 'INVALID_LOGIN' }); ps.close();
  } finally { a.server.close(); }
  const b = await fake({ offer: 'Basic' });
  try {
    const ps = await connect({ host: '127.0.0.1', port: b.port, username: 'administrator', password: 'right', tls: { mode: 'pinned', sha256: pin } });
    assert.deepEqual(await ps('x'), { hello: 'dünya' }); ps.close();
  } finally { b.server.close(); }
});

test('a script that fails gives its code; an unknown certificate and a blocked address are refused', { skip }, async () => {
  const a = await fake({ result: 'LVM:DISK_HAS_SNAPSHOTS:remove the checkpoints before growing the disk\r\n', exitCode: 1 });
  try {
    const target = { host: '127.0.0.1', port: a.port, username: 'LAB\\admin', password: 'right' };
    const ps = await connect({ ...target, tls: { mode: 'pinned', sha256: pin } });
    await assert.rejects(ps('x'), { code: 'DISK_HAS_SNAPSHOTS', message: 'remove the checkpoints before growing the disk' }); ps.close();
    const before = a.seen.actions.length;
    const untrusted = await connect({ ...target, tls: { mode: 'system' } });
    const e = await untrusted('x').catch((x) => x);
    assert.equal(e.code, 'TLS_UNTRUSTED'); assert.equal(e.certificate.sha256, pin); untrusted.close();
    const other = await connect({ ...target, tls: { mode: 'pinned', sha256: 'd'.repeat(64) } });
    await assert.rejects(other('x'), { code: 'TLS_PIN_MISMATCH' }); other.close();
    assert.equal(a.seen.actions.length, before, 'nothing is sent to an endpoint that is not trusted');
    await assert.rejects(connect({ ...target, host: '169.254.169.254', tls: { mode: 'system' } }), { code: 'ENDPOINT_BLOCKED' });
  } finally { a.server.close(); }
});
