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

test('Param: the browser return never marks a payment paid; a well-formed one is left for staff to confirm', async () => {
  const { paramAmount } = await import('../dist/billing-providers.js');
  const { finalResult, needsReview } = await import('../dist/billing-gateways.js');
  const creds = { CLIENT_CODE: '10738', CLIENT_USERNAME: 'Test', CLIENT_PASSWORD: 'Test', GUID: 'g', endpoint: 'https://testposws.param.com.tr/x' };
  const r = { TURKPOS_RETVAL_Sonuc: '1', TURKPOS_RETVAL_GUID: 'g', TURKPOS_RETVAL_Dekont_ID: '55', TURKPOS_RETVAL_Tahsilat_Tutari: '120,00', TURKPOS_RETVAL_Siparis_ID: 'S1',
    TURKPOS_RETVAL_Islem_ID: payment.id.replace(/-/g, '') };
  const sign = (b) => ({ ...b, TURKPOS_RETVAL_Hash: createHash('sha1').update(Buffer.from('10738' + b.TURKPOS_RETVAL_GUID + b.TURKPOS_RETVAL_Dekont_ID + b.TURKPOS_RETVAL_Tahsilat_Tutari
    + b.TURKPOS_RETVAL_Siparis_ID + b.TURKPOS_RETVAL_Islem_ID, 'latin1')).digest('base64') });
  const verify = (body, p = payment) => param.verify({ query: {}, body, payment: p }, creds, 'test');
  // Everything in the form can be made by someone who knows the merchant's code and GUID: no outbound request confirms it,
  // so the best such a return gets is "a person must look", which settles nothing.
  const real = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async () => { asked++; return new Response('', { status: 500 }); };
  try {
    const best = await verify(sign(r));
    assert.equal(best.ok, false);
    assert.equal(best.code, 'NEEDS_CONFIRMATION');
    assert.match(best.message, /S1.*55.*120,00/);
    assert.equal(finalResult(best), false);
    assert.equal(needsReview(best), true);
    assert.equal((await verify(sign({ ...r, TURKPOS_RETVAL_Tahsilat_Tutari: '1.120,00' }))).code, 'NEEDS_CONFIRMATION', 'more than asked, with a thousands separator');
    assert.equal((await verify({ ...sign(r), TURKPOS_RETVAL_Hash: 'x' })).code, 'BAD_SIGNATURE');
    assert.equal((await verify(sign({ ...r, TURKPOS_RETVAL_Sonuc: '-1' }))).code, 'CARD_DECLINED');
    assert.equal((await verify(sign({ ...r, TURKPOS_RETVAL_Tahsilat_Tutari: '1,00' }))).code, 'AMOUNT_MISMATCH');
    // The result flag and the amount must be numbers: "abc" used to pass as "not smaller".
    for (const amount of ['abc', '', '120,00x', '1e9', '-120,00', '12,0,0', 'NaN']) assert.equal((await verify(sign({ ...r, TURKPOS_RETVAL_Tahsilat_Tutari: amount }))).code, 'BAD_SIGNATURE', amount);
    for (const sonuc of ['', 'ok', '1x', '0x1', '1.5']) assert.equal((await verify(sign({ ...r, TURKPOS_RETVAL_Sonuc: sonuc }))).code, 'BAD_SIGNATURE', sonuc);
    assert.equal((await verify(sign({ ...r, TURKPOS_RETVAL_Sonuc: '0' }))).code, 'CARD_DECLINED');
    // Every input of the hash is in the posted form: the GUID must be the configured one, and the result must name this payment.
    assert.equal((await verify(sign({ ...r, TURKPOS_RETVAL_GUID: 'another' }))).code, 'BAD_SIGNATURE');
    assert.equal((await verify(sign({ ...r, TURKPOS_RETVAL_Islem_ID: '' }))).code, 'BAD_SIGNATURE');
    assert.equal((await verify(sign({ ...r, TURKPOS_RETVAL_Islem_ID: 'b'.repeat(32) }))).code, 'BAD_SIGNATURE');
    // Param collects lira: the same number is not 120 USD.
    for (const currency of ['USD', 'EUR']) {
      const foreign = await verify(sign(r), { ...payment, currency });
      assert.equal(foreign.code, 'AMOUNT_MISMATCH', currency);
      assert.equal(finalResult(foreign), false);
    }
    assert.equal(asked, 0);
  } finally { globalThis.fetch = real; }
  assert.deepEqual(['120,00', '120', '1.234,5', '1234,56', '120.00', '1.234.567,89'].map(paramAmount), [12000, 12000, 123450, 123456, 12000, 123456789]);
  assert.deepEqual(['', 'abc', '12,345', '1.2', '1,234.56', ' 120,00', '120,00 '].map(paramAmount), [null, null, null, null, null, null, null]);
});

test('Param: only lira payments are started, and no currency other than TRY is offered', async () => {
  const { gateways } = await import('../dist/billing-gateways.js');
  assert.deepEqual(gateways.param.currencies, ['TRY']);
  for (const id of ['iyzico', 'paytr', 'stripe', 'craftgate', 'sandbox']) assert.equal(gateways[id].currencies, undefined, id);
  const creds = { CLIENT_CODE: '10738', CLIENT_USERNAME: 'Test', CLIENT_PASSWORD: 'Test', GUID: 'g', endpoint: 'https://testposws.param.com.tr/x' };
  const c = { paymentId: payment.id, amount: '1500.00', currency: 'USD', description: 'x', saveCard: false, returnUrl: 'https://p.example/r', callbackUrl: 'https://p.example/c',
    buyer: { id: 'u', name: 'A B', email: 'a@example.test', taxId: '', phone: '', address: '', city: '', country: 'TR', ip: '127.0.0.1' } };
  const real = globalThis.fetch;
  let sent = '';
  globalThis.fetch = async (_url, init) => { sent = String(init.body); return new Response('<TO_Pre_Encrypting_OOSResult>abc</TO_Pre_Encrypting_OOSResult>', { status: 200 }); };
  try {
    await assert.rejects(param.checkout(c, creds, 'test'), /only TRY/);
    assert.equal(sent, '', 'nothing is asked of Param for a dollar payment');
    const out = await param.checkout({ ...c, currency: 'TRY' }, creds, 'test');
    assert.match(out.redirect, /^https:\/\/testpos\.param\.com\.tr\/Tahsilat\/Default\.aspx\?s=abc$/);
    assert.match(sent, /<Borclu_Tutar>r\|1500,00<\/Borclu_Tutar>/);
  } finally { globalThis.fetch = real; }
});

test('PayTR and iyzico: a signature of another length, or an amount that is not a number, is refused', async () => {
  const { iyzico } = await import('../dist/billing-providers.js');
  const creds = { merchant_id: '1', merchant_key: 'key', merchant_salt: 'salt', endpoint: 'https://www.paytr.com' };
  const oid = payment.id.replace(/-/g, '');
  const signed = (b) => ({ ...b, hash: createHmac('sha256', 'key').update(`${b.merchant_oid}salt${b.status}${b.total_amount}`).digest('base64') });
  const good = signed({ merchant_oid: oid, status: 'success', total_amount: '12000', payment_amount: '12000' });
  for (const hash of ['', good.hash.slice(0, -1), `${good.hash}=`, good.hash.toLowerCase()]) assert.equal((await paytr.verify({ query: {}, body: { ...good, hash }, payment }, creds, 'test')).code, 'BAD_SIGNATURE', hash);
  assert.equal((await paytr.verify({ query: {}, body: signed({ merchant_oid: oid, status: 'success', total_amount: 'abc', payment_amount: 'abc' }), payment }, creds, 'test')).code, 'AMOUNT_MISMATCH');
  // iyzico's answer carries a signature over its fields: one that does not match is not iyzico's answer.
  const ic = { apiKey: 'a', secretKey: 's', endpoint: 'https://sandbox-api.iyzipay.com' };
  const answer = { status: 'success', paymentStatus: 'SUCCESS', paymentId: '77', currency: 'TRY', basketId: payment.id, conversationId: payment.id, paidPrice: 120, price: 120, token: 'tok' };
  const sig = createHmac('sha256', 's').update([answer.paymentStatus, answer.paymentId, answer.currency, answer.basketId, answer.conversationId, answer.paidPrice, answer.price, answer.token].join(':')).digest('hex');
  const real = globalThis.fetch;
  const reply = (body) => { globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 }); };
  const stored = { ...payment, providerRef: 'tok' };
  try {
    reply({ ...answer, signature: sig });
    assert.deepEqual(await iyzico.verify({ query: {}, body: { token: 'tok' }, payment: stored }, ic, 'test'), { ok: true, ref: '77' });
    for (const bad of [sig.slice(1), `${sig}0`, sig.replace(/^./, (ch) => (ch === 'a' ? 'b' : 'a'))]) {
      reply({ ...answer, signature: bad });
      assert.equal((await iyzico.verify({ query: {}, body: { token: 'tok' }, payment: stored }, ic, 'test')).code, 'BAD_SIGNATURE');
    }
  } finally { globalThis.fetch = real; }
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
  // Nor on an answer a person must look at: closed as failed, the customer would pay again while the provider may hold the money.
  const { needsReview } = await import('../dist/billing-gateways.js');
  for (const code of ['NEEDS_CONFIRMATION', 'AMOUNT_MISMATCH', 'FRAUD_REVIEW']) assert.deepEqual([finalResult({ ok: false, code }), needsReview({ ok: false, code })], [false, true], code);
  for (const r of [{ ok: true, ref: 'x' }, { ok: false, code: 'CARD_DECLINED' }, { ok: false, code: 'PENDING' }]) assert.equal(needsReview(r), false);
});
