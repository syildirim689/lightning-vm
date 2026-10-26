// E-mail API providers without real accounts: the request each one makes (URL, credentials header, body) and
// how answers map to the panel's codes, through a stubbed fetch.
import test from 'node:test';
import assert from 'node:assert/strict';

const { mailProviders, readProviderFields, sigV4 } = await import('../dist/mail-providers.js');
const msg = { from: { name: 'Lightning VM', address: 'panel@example.com' }, to: 'ops@example.net', subject: 'Hi', text: 'Body' };

function stub(status, body) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }); };
  return calls;
}

test('every provider has a name, documentation and at least one secret field', () => {
  assert.ok(Object.keys(mailProviders).length >= 12);
  for (const [id, p] of Object.entries(mailProviders)) {
    assert.match(p.docs, /^https:\/\//, id);
    assert.ok(p.fields.some((f) => f.secret), `${id} has a secret field`);
  }
});

test('Resend: bearer key, from line with the name; 401 is an authentication failure', async () => {
  let calls = stub(200, { id: 're_123' });
  const ok = await mailProviders.resend.send({ apiKey: 're_key' }, msg);
  assert.deepEqual(ok, { ok: true, ref: 're_123' });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.authorization, 'Bearer re_key');
  assert.equal(JSON.parse(calls[0].init.body).from, 'Lightning VM <panel@example.com>');
  calls = stub(401, { message: 'API key is invalid' });
  assert.equal((await mailProviders.resend.send({ apiKey: 'bad' }, msg)).code, 'MAIL_AUTH_FAILED');
});

test('Mailgun EU region and domain in the URL, form body; SendGrid EU host; a refused message is MAIL_REJECTED', async () => {
  let calls = stub(200, { id: '<x@mg>' });
  await mailProviders.mailgun.send({ apiKey: 'k', domain: 'mg.example.com', region: 'eu' }, msg);
  assert.equal(calls[0].url, 'https://api.eu.mailgun.net/v3/mg.example.com/messages');
  assert.match(calls[0].init.body, /to=ops%40example.net/);
  calls = stub(202, '');
  assert.equal((await mailProviders.sendgrid.send({ apiKey: 'SG.x', region: 'eu' }, msg)).ok, true);
  assert.equal(calls[0].url, 'https://api.eu.sendgrid.com/v3/mail/send');
  stub(400, { errors: [{ message: 'from address not verified' }] });
  const r = await mailProviders.sendgrid.send({ apiKey: 'SG.x' }, msg);
  assert.equal(r.code, 'MAIL_REJECTED');
  assert.match(r.detail, /not verified/);
});

test('Mailjet and SMTP2GO read their per-message status from a 200 answer', async () => {
  stub(200, { Messages: [{ Status: 'error', Errors: [{ ErrorMessage: 'bad sender' }] }] });
  assert.equal((await mailProviders.mailjet.send({ apiKey: 'a', secretKey: 'b' }, msg)).code, 'MAIL_REJECTED');
  stub(200, { data: { succeeded: 1, email_id: 'e1' } });
  assert.deepEqual(await mailProviders.smtp2go.send({ apiKey: 'api-x' }, msg), { ok: true, ref: 'e1' });
});

test('Amazon SES: signed with SigV4 for the region; a bad region is refused before any call', async () => {
  const calls = stub(200, { MessageId: 'm-1' });
  assert.deepEqual(await mailProviders.ses.send({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', region: 'eu-central-1' }, msg), { ok: true, ref: 'm-1' });
  assert.equal(calls[0].url, 'https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails');
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal((await mailProviders.ses.send({ accessKeyId: 'a', secretAccessKey: 'b', region: 'mars' }, msg)).code, 'MAIL_REJECTED');
  // Same input, same signature; another secret, another one.
  const base = { method: 'POST', host: 'h', path: '/p', region: 'us-east-1', service: 'ses', body: '{}', accessKey: 'A', now: new Date('2026-01-02T03:04:05Z') };
  assert.equal(sigV4({ ...base, secretKey: 's' }).authorization, sigV4({ ...base, secretKey: 's' }).authorization);
  assert.notEqual(sigV4({ ...base, secretKey: 's' }).authorization, sigV4({ ...base, secretKey: 't' }).authorization);
  assert.equal(sigV4({ ...base, secretKey: 's' })['x-amz-date'], '20260102T030405Z');
});

test('no connection is MAIL_CONNECTION_FAILED', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  assert.equal((await mailProviders.postmark.send({ serverToken: 't' }, msg)).code, 'MAIL_CONNECTION_FAILED');
});

test('form fields: required ones, option lists, secrets kept when left empty', () => {
  assert.deepEqual(readProviderFields('mailgun', { apiKey: '', domain: '', region: 'mars' }, {}).fields, { apiKey: 'REQUIRED', domain: 'REQUIRED', region: 'INVALID_VALUE' });
  const r = readProviderFields('mailgun', { apiKey: '', domain: 'mg.example.com', region: 'eu' }, { apiKey: 'saved' });
  assert.deepEqual(r, { plain: { domain: 'mg.example.com', region: 'eu' }, secrets: { apiKey: 'saved' }, fields: {} });
});
