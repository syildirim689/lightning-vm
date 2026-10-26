// Payment credential checks build the signed requests their docs describe and classify the answers
// conservatively. fetch is replaced: no network, no real merchant accounts, no money.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

const { providers, checkCredentials } = await import('../dist/payment-providers.js');
let seen;
function reply(status, body) {
  globalThis.fetch = async (url, init = {}) => { seen = { url: String(url), init }; return new Response(body, { status }); };
}

test('every provider declares fields, hosts for both modes, and https endpoints', () => {
  assert.ok(Object.keys(providers).length >= 35);
  for (const [id, p] of Object.entries(providers)) {
    assert.ok(p.fields.length > 0, id);
    for (const m of ['live', 'test']) assert.match(p.hosts[m], /^https:\/\//, `${id} ${m}`);
    assert.ok(p.fields.some((f) => f.secret), `${id} has a secret`);
    if (!p.check) assert.ok(p.notes.includes('NO_SERVER_CHECK'), `${id} says it cannot be checked`);
  }
});

test('iyzico: IYZWSv2 signature over random key + path + body; success is ok', async () => {
  reply(200, '{"status":"success","cardAssociation":"MASTER_CARD","bankName":"Halkbank"}');
  const r = await checkCredentials('iyzico', { apiKey: 'AK', secretKey: 'SK' }, 'test');
  assert.equal(r.status, 'ok');
  assert.equal(seen.url, 'https://sandbox-api.iyzipay.com/payment/bin/check');
  const rnd = seen.init.headers['x-iyzi-rnd'];
  const decoded = Buffer.from(seen.init.headers.authorization.replace('IYZWSv2 ', ''), 'base64').toString();
  const sig = createHmac('sha256', 'SK').update(rnd + '/payment/bin/check' + seen.init.body).digest('hex');
  assert.equal(decoded, `apiKey:AK&randomKey:${rnd}&signature:${sig}`);
});

test('iyzico: a failure answer is a rejection with the provider message', async () => {
  reply(401, '{"status":"failure","errorCode":"1001","errorMessage":"api bilgileri bulunamadı"}');
  const r = await checkCredentials('iyzico', { apiKey: 'AK', secretKey: 'SK' }, 'live');
  assert.deepEqual([r.status, r.message], ['rejected', '1001 api bilgileri bulunamadı']);
});

test('PayTR: token = base64 HMAC-SHA256(key, bin + merchant_id + salt); "error" rejects', async () => {
  reply(200, '{"status":"error","err_msg":"paytr_token gecersiz"}');
  const r = await checkCredentials('paytr', { merchant_id: '1', merchant_key: 'k', merchant_salt: 's' }, 'live');
  assert.equal(r.status, 'rejected');
  const form = new URLSearchParams(seen.init.body);
  assert.equal(form.get('paytr_token'), createHmac('sha256', 'k').update('435508' + '1' + 's').digest('base64'));
  reply(200, '{"status":"failed"}'); // unknown BIN, but the credentials were accepted
  assert.equal((await checkCredentials('paytr', { merchant_id: '1', merchant_key: 'k', merchant_salt: 's' }, 'test')).status, 'ok');
});

test('Moka: CheckKey = SHA256 hex of DealerCode + MK + Username + PD + Password', async () => {
  reply(200, '{"ResultCode":"PaymentDealer.CheckPaymentDealerAuthentication.InvalidAccount"}');
  const r = await checkCredentials('moka', { DealerCode: 'D', Username: 'U', Password: 'P' }, 'test');
  assert.equal(r.status, 'rejected');
  assert.equal(JSON.parse(seen.init.body).PaymentDealerAuthentication.CheckKey, createHash('sha256').update('DMKUPDP').digest('hex'));
});

test('bank status queries: "not found" proves the credentials, an auth complaint rejects them', async () => {
  const c = { clientId: '700655000200', username: 'ISBANKAPI', password: 'ISBANK07', storeKey: 'TRPS0200' };
  reply(200, '<CC5Response><Response>Error</Response><ErrMsg>Kayıt bulunamadı</ErrMsg></CC5Response>');
  const found = await checkCredentials('nestpay-isbank', c, 'test');
  assert.equal(found.status, 'ok');
  assert.deepEqual(found.unverified, ['storeKey'], 'the 3D key cannot be checked by any API');
  assert.equal(seen.url, 'https://istest.asseco-see.com.tr/fim/api');
  assert.match(seen.init.body, /<ORDERSTATUS>QUERY<\/ORDERSTATUS>/);
  reply(200, '<CC5Response><Response>Error</Response><ErrMsg>Hatalı kullanıcı adı veya şifre</ErrMsg></CC5Response>');
  assert.equal((await checkCredentials('nestpay-isbank', c, 'test')).status, 'rejected');
  reply(200, '<CC5Response><Response>Error</Response><ErrMsg>Kullanıcı bulunamadı</ErrMsg></CC5Response>');
  assert.equal((await checkCredentials('nestpay-isbank', c, 'test')).status, 'rejected', 'a missing user is not a missing order');
  reply(200, '<CC5Response><Response>Error</Response><ErrMsg>Sistem hatası 99</ErrMsg></CC5Response>');
  assert.equal((await checkCredentials('nestpay-isbank', c, 'test')).status, 'inconclusive');
});

test('Garanti: hash data from the provision password and the zero-padded terminal id', async () => {
  reply(200, '<GVPSResponse><Transaction><Response><Code>99</Code><ErrorMsg>Siparis bulunamadi</ErrorMsg></Response></Transaction></GVPSResponse>');
  const c = providers.garanti.testCredentials;
  const r = await checkCredentials('garanti', c, 'test');
  assert.equal(r.status, 'ok');
  const order = /<OrderID>([^<]+)<\/OrderID>/.exec(seen.init.body)[1];
  const security = createHash('sha1').update('123qweASD/' + '030691297').digest('hex').toUpperCase();
  const expected = createHash('sha512').update(order + '30691297' + '100' + '949' + security).digest('hex').toUpperCase();
  assert.match(seen.init.body, new RegExp(`<HashData>${expected}</HashData>`));
  assert.match(seen.init.body, /<Mode>TEST<\/Mode>/);
});

test('blocked by IP and unreachable providers are network problems; secrets are never echoed', async () => {
  reply(403, 'Forbidden');
  assert.equal((await checkCredentials('paynet', { secret_key: 'sck_1' }, 'live')).status, 'network');
  globalThis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  assert.deepEqual(await checkCredentials('paynet', { secret_key: 'sck_1' }, 'live'), { status: 'network', message: 'ENOTFOUND', unverified: [] });
  reply(200, '{"code":7,"message":"invalid key sck_supersecret"}');
  const r = await checkCredentials('paynet', { secret_key: 'sck_supersecret' }, 'live');
  assert.equal(r.status, 'rejected');
  assert.ok(!r.message.includes('sck_supersecret'));
});

test('providers without a read-only API say so instead of faking success', async () => {
  globalThis.fetch = async () => assert.fail('no request expected');
  const r = await checkCredentials('shopier', { apiKey: 'a', apiSecret: 'b' }, 'live');
  assert.equal(r.status, 'unverifiable');
});

test('an endpoint override replaces the host for that mode', async () => {
  reply(200, '{"code":0}');
  await checkCredentials('paynet', { secret_key: 'k', endpoint: 'https://pay.example.com/' }, 'test');
  assert.equal(seen.url, 'https://pay.example.com/v1/ratio/Get');
});

test('international: key/mode mismatch caught before any call; Stripe, Checkout.com (404 = key accepted), PayPal token', async () => {
  const { checkCredentials } = await import('../dist/payment-providers.js');
  let calls = 0;
  const answer = (status, body) => { globalThis.fetch = async (url, init) => { calls++; answer.last = { url: String(url), init }; return new Response(body, { status }); }; };
  answer(200, '{}');
  assert.equal((await checkCredentials('stripe', { secretKey: 'sk_live_abc' }, 'test')).status, 'rejected');
  assert.equal(calls, 0);
  assert.equal((await checkCredentials('stripe', { secretKey: 'sk_test_abc' }, 'test')).status, 'ok');
  assert.equal(answer.last.url, 'https://api.stripe.com/v1/balance');
  assert.equal(answer.last.init.headers.authorization, 'Bearer sk_test_abc');
  answer(404, '');
  assert.equal((await checkCredentials('checkoutcom', { secretKey: 'sk_sbox_x' }, 'test')).status, 'ok');
  assert.match(answer.last.url, /^https:\/\/api\.sandbox\.checkout\.com\/payments\//);
  answer(401, JSON.stringify({ error: 'invalid_client', error_description: 'Client Authentication failed' }));
  const pp = await checkCredentials('paypal', { clientId: 'id', clientSecret: 'secret' }, 'test');
  assert.equal(pp.status, 'rejected');
  assert.equal(answer.last.url, 'https://api-m.sandbox.paypal.com/v1/oauth2/token');
  answer(401, '{"message":"Unauthorized"}');
  assert.equal((await checkCredentials('mollie', { apiKey: 'test_x' }, 'test')).status, 'rejected');
});
