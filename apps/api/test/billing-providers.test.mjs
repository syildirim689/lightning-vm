import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

const { iyziPrice, paytr, param } = await import('../dist/billing-providers.js');

const payment = { id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', amount: '120.00', currency: 'TRY', providerRef: null };

test('iyzico prices are written as its SDKs write them', () => {
  assert.equal(iyziPrice('10.00'), '10.0');
  assert.equal(iyziPrice('10.50'), '10.5');
  assert.equal(iyziPrice('10.55'), '10.55');
  assert.equal(iyziPrice('1200'), '1200.0');
});

test('PayTR: the notification finds our payment, its hash is checked, failures and short amounts are refused', async () => {
  const creds = { merchant_id: '1', merchant_key: 'key', merchant_salt: 'salt', endpoint: 'https://www.paytr.com' };
  const oid = payment.id.replace(/-/g, '');
  assert.equal(paytr.paymentIdFrom({ merchant_oid: oid }), payment.id);
  assert.equal(paytr.paymentIdFrom({ merchant_oid: 'x-1' }), null);
  const signed = (b) => ({ ...b, hash: createHmac('sha256', 'key').update(`${b.merchant_oid}salt${b.status}${b.total_amount}`).digest('base64') });
  const ok = await paytr.verify({ query: {}, body: signed({ merchant_oid: oid, status: 'success', total_amount: '12000', payment_amount: '12000' }), payment }, creds, 'test');
  assert.deepEqual(ok, { ok: true, ref: oid });
  assert.equal((await paytr.verify({ query: {}, body: { ...signed({ merchant_oid: oid, status: 'success', total_amount: '12000' }), hash: 'forged' }, payment }, creds, 'test')).code, 'BAD_SIGNATURE');
  assert.equal((await paytr.verify({ query: {}, body: signed({ merchant_oid: oid, status: 'failed', total_amount: '12000', failed_reason_code: '6' }), payment }, creds, 'test')).code, 'PAYTR_6');
  assert.equal((await paytr.verify({ query: {}, body: signed({ merchant_oid: oid, status: 'success', total_amount: '100', payment_amount: '100' }), payment }, creds, 'test')).code, 'AMOUNT_MISMATCH');
  // A genuine notification of another payment, sent to this payment's address, is not this payment's result.
  const other = 'a'.repeat(32);
  assert.equal((await paytr.verify({ query: {}, body: signed({ merchant_oid: other, status: 'success', total_amount: '12000', payment_amount: '12000' }), payment }, creds, 'test')).code, 'BAD_SIGNATURE');
  assert.equal(paytr.reply, 'OK');
});

test('Param: the return is accepted only with its hash, a positive result and the full amount', async () => {
  const creds = { CLIENT_CODE: '10738', CLIENT_USERNAME: 'Test', CLIENT_PASSWORD: 'Test', GUID: 'g', endpoint: 'https://testposws.param.com.tr/x' };
  const r = { TURKPOS_RETVAL_Sonuc: '1', TURKPOS_RETVAL_GUID: 'g', TURKPOS_RETVAL_Dekont_ID: '55', TURKPOS_RETVAL_Tahsilat_Tutari: '120,00', TURKPOS_RETVAL_Siparis_ID: 'S1',
    TURKPOS_RETVAL_Islem_ID: payment.id.replace(/-/g, '') };
  const sign = (b) => ({ ...b, TURKPOS_RETVAL_Hash: createHash('sha1').update(Buffer.from('10738' + b.TURKPOS_RETVAL_GUID + b.TURKPOS_RETVAL_Dekont_ID + b.TURKPOS_RETVAL_Tahsilat_Tutari
    + b.TURKPOS_RETVAL_Siparis_ID + b.TURKPOS_RETVAL_Islem_ID, 'latin1')).digest('base64') });
  assert.deepEqual(await param.verify({ query: {}, body: sign(r), payment }, creds, 'test'), { ok: true, ref: 'S1' });
  assert.equal((await param.verify({ query: {}, body: { ...sign(r), TURKPOS_RETVAL_Hash: 'x' }, payment }, creds, 'test')).code, 'BAD_SIGNATURE');
  assert.equal((await param.verify({ query: {}, body: sign({ ...r, TURKPOS_RETVAL_Sonuc: '-1' }), payment }, creds, 'test')).code, 'CARD_DECLINED');
  assert.equal((await param.verify({ query: {}, body: sign({ ...r, TURKPOS_RETVAL_Tahsilat_Tutari: '1,00' }), payment }, creds, 'test')).code, 'AMOUNT_MISMATCH');
  // Every input of the hash is in the posted form: the GUID must be the configured one, and the result must name this payment.
  assert.equal((await param.verify({ query: {}, body: sign({ ...r, TURKPOS_RETVAL_GUID: 'another' }), payment }, creds, 'test')).code, 'BAD_SIGNATURE');
  assert.equal((await param.verify({ query: {}, body: sign({ ...r, TURKPOS_RETVAL_Islem_ID: '' }), payment }, creds, 'test')).code, 'BAD_SIGNATURE');
  assert.equal((await param.verify({ query: {}, body: sign({ ...r, TURKPOS_RETVAL_Islem_ID: 'b'.repeat(32) }), payment }, creds, 'test')).code, 'BAD_SIGNATURE');
});

test('Stripe: asked without the browser, an open session stays pending, an expired one fails, a paid one settles', async () => {
  const { stripe } = await import('../dist/billing-providers.js');
  const creds = { secretKey: 'sk_test_x' };
  const real = globalThis.fetch;
  let asked = '';
  const answer = (body) => { globalThis.fetch = async (url) => { asked = String(url); return new Response(JSON.stringify(body), { status: 200 }); }; };
  const stored = { ...payment, providerRef: 'cs_test_abc' };
  try {
    // The session id comes from the payment itself (stored at checkout), not from the browser's return.
    answer({ id: 'cs_test_abc', status: 'open', payment_status: 'unpaid', client_reference_id: payment.id });
    assert.equal((await stripe.verify({ query: {}, body: {}, payment: stored }, creds, 'test')).code, 'PENDING');
    assert.match(asked, /\/v1\/checkout\/sessions\/cs_test_abc\?/);
    answer({ id: 'cs_test_abc', status: 'expired', payment_status: 'unpaid', client_reference_id: payment.id });
    assert.equal((await stripe.verify({ query: {}, body: {}, payment: stored }, creds, 'test')).code, 'EXPIRED');
    answer({ id: 'cs_test_abc', status: 'complete', payment_status: 'paid', client_reference_id: payment.id, amount_total: 12000, currency: 'try', payment_intent: { id: 'pi_1' } });
    assert.deepEqual(await stripe.verify({ query: {}, body: {}, payment: stored }, creds, 'test'), { ok: true, ref: 'pi_1' });
    // Nothing to ask with (an older payment, no session id stored, no return): not a failure.
    assert.equal((await stripe.verify({ query: {}, body: {}, payment }, creds, 'test')).code, 'NO_SESSION');
  } finally { globalThis.fetch = real; }
});

test('a payment is failed only on the provider\'s word: unfinished, unanswered or foreign answers leave it open', async () => {
  const { finalResult } = await import('../dist/billing-gateways.js');
  assert.equal(finalResult({ ok: true, ref: 'x' }), true);
  assert.equal(finalResult({ ok: false, code: 'CARD_DECLINED' }), true);
  assert.equal(finalResult({ ok: false, code: 'EXPIRED' }), true);
  for (const code of ['PENDING', 'PROVIDER_ERROR', 'BAD_SIGNATURE', 'NO_TOKEN', 'NO_SESSION']) assert.equal(finalResult({ ok: false, code }), false, code);
});
