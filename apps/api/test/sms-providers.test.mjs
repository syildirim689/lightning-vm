// The SMS providers build the requests their docs describe and read success the documented way.
// fetch is replaced: no network, no real accounts.
import test from 'node:test';
import assert from 'node:assert/strict';

const { providers, phoneForms } = await import('../dist/sms-providers.js');
const to = phoneForms('+905321234567');
let seen;
function reply(status, body) {
  globalThis.fetch = async (url, init = {}) => { seen = { url: String(url), init }; return new Response(body, { status }); };
}

test('phone numbers are given in each documented form', () => {
  assert.deepEqual(to, { e164: '+905321234567', international: '905321234567', national: '5321234567', zeroNational: '05321234567' });
});

test('NetGSM: Basic auth, national number, Turkish encoding; "00" is success', async () => {
  reply(200, '{"code":"00","jobid":"J1"}');
  const r = await providers.netgsm.send({ credentials: { username: '8501234567', password: 'p' }, sender: 'ACME', commercial: false }, to, 'Kod: 1');
  assert.deepEqual(r, { ok: true, ref: 'J1' });
  const body = JSON.parse(seen.init.body);
  assert.equal(seen.init.headers.authorization, `Basic ${Buffer.from('8501234567:p').toString('base64')}`);
  assert.deepEqual([body.messages[0].no, body.encoding, body.iysfilter, body.msgheader], ['5321234567', 'TR', '0', 'ACME']);
  reply(200, '{"code":"30"}');
  assert.equal((await providers.netgsm.send({ credentials: { username: 'u', password: 'p' }, sender: 'A', commercial: true }, to, 'x')).code, 'SMS_AUTH_FAILED');
});

test('Verimor: international number; 200 with the campaign id is success, 400 is a rejection', async () => {
  reply(200, '123456');
  assert.equal((await providers.verimor.send({ credentials: { username: '908501234567', password: 'p' }, sender: 'ACME', commercial: false }, to, 'x')).ok, true);
  assert.equal(JSON.parse(seen.init.body).messages[0].dest, '905321234567');
  reply(400, 'INVALID_SOURCE_ADDRESS');
  assert.deepEqual(await providers.verimor.send({ credentials: { username: 'u', password: 'p' }, sender: '', commercial: false }, to, 'x'), { ok: false, code: 'SMS_REJECTED', detail: 'INVALID_SOURCE_ADDRESS' });
});

test('İleti Merkezi: key/hash in the body, iys flag always sent; status 200 is success', async () => {
  reply(200, '{"response":{"status":{"code":"200"},"order":{"id":"77"}}}');
  const r = await providers.iletimerkezi.send({ credentials: { apiKey: 'k', apiHash: 'h' }, sender: 'APITEST', commercial: false }, to, 'x');
  assert.deepEqual(r, { ok: true, ref: '77' });
  const o = JSON.parse(seen.init.body).request;
  assert.deepEqual([o.authentication.key, o.order.iys, o.order.message.receipents.number[0]], ['k', '0', '5321234567']);
});

test('Mutlucell: XML is escaped; a "$" reply is success', async () => {
  reply(200, '$34672#1.0');
  const r = await providers.mutlucell.send({ credentials: { username: 'u', password: 'p&<' }, sender: 'ACME', commercial: false }, to, 'a <b> & c');
  assert.equal(r.ok, true);
  assert.match(seen.init.body, /pwd="p&amp;&lt;"/);
  assert.match(seen.init.body, /<metin>a &lt;b&gt; &amp; c<\/metin>/);
});

test('TTMesaj: token first, then the send with Bearer; "*OK*" is success', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    return String(url).includes('TokenJson') ? new Response('{"access_token":"T"}') : new Response('{"sonuc":"*OK*998","kontor":10}');
  };
  const r = await providers.ttmesaj.send({ credentials: { username: 'u', password: 'p' }, sender: 'ACME', commercial: false }, to, 'x');
  assert.deepEqual(r, { ok: true, ref: '998' });
  assert.ok(calls[0].includes('TokenJson') && calls[1].includes('SendSingle'));
});

test('Posta Güvercini: ISO-8859-9 percent-encoding for Turkish letters', async () => {
  reply(200, 'errno=0&errtext=&message_id=5&charge=1');
  assert.equal((await providers.postaguvercini.send({ credentials: { username: 'u', password: 'p' }, sender: '', commercial: false }, to, 'Şğı')).ok, true);
  assert.match(seen.url, /text=%DE%F0%FD/);
});

test('Custom API: templates are filled and the success pattern decides', async () => {
  reply(200, 'OK 1');
  const c = { url: 'https://sms.example/send?to={to}', method: 'POST', contentType: 'json', body: '{"t":"{text}"}', phoneFormat: 'e164', successPattern: '^OK' };
  assert.equal((await providers.custom.send({ credentials: c, sender: '', commercial: false }, to, 'he said "hi"')).ok, true);
  assert.equal(seen.url, 'https://sms.example/send?to=%2B905321234567');
  assert.deepEqual(JSON.parse(seen.init.body), { t: 'he said "hi"' });
});
