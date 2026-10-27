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
});
