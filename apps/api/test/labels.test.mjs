// What authenticator apps and passkey managers show: the panel's brand as issuer, the e-mail as account (labels.ts).
import test from 'node:test';
import assert from 'node:assert/strict';

const { issuerName, totpUri, relabelTotp, relabelRegistration } = await import('../dist/labels.js');

test('the brand is the issuer: one line, no colon, at most 64 characters, the product name when empty', () => {
  assert.equal(issuerName('Acme Cloud'), 'Acme Cloud');
  assert.equal(issuerName('  Acme:\tCloud\n'), 'Acme Cloud');
  assert.equal(issuerName(''), 'Lightning VM');
  assert.equal(issuerName(null), 'Lightning VM');
  assert.equal(issuerName(':::'), 'Lightning VM');
  assert.equal(issuerName('x'.repeat(80)).length, 64);
  assert.equal(issuerName('Bulut Şirketi Ç'), 'Bulut Şirketi Ç');
});

test('the URI has "Issuer:account" as label and the same issuer as parameter, both percent-encoded', () => {
  const uri = totpUri({ issuer: 'Acme Cloud & Co', account: 'ayşe+test@example.com', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30 });
  assert.equal(uri, 'otpauth://totp/Acme%20Cloud%20%26%20Co:ay%C5%9Fe%2Btest%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme%20Cloud%20%26%20Co&digits=6&period=30');
  assert.ok(!uri.includes('+'), 'a space is never a plus sign');
  const u = new URL(uri);
  assert.equal(u.searchParams.get('issuer'), 'Acme Cloud & Co');
  assert.equal(u.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
  assert.equal(decodeURIComponent(u.pathname.slice(1)), 'Acme Cloud & Co:ayşe+test@example.com');
});

test('better-auth\'s URI keeps its secret, digits and period under the panel\'s name', () => {
  // As @better-auth/utils builds it: the fixed app name, URLSearchParams (a space as "+").
  const theirs = 'otpauth://totp/Lightning%20VM:user%40example.com?secret=GEZDGNBVGY3TQOJQ&issuer=Lightning+VM&digits=6&period=30';
  const ours = relabelTotp(theirs, 'Acme: Cloud', 'user@example.com');
  assert.equal(ours, 'otpauth://totp/Acme%20Cloud:user%40example.com?secret=GEZDGNBVGY3TQOJQ&issuer=Acme%20Cloud&digits=6&period=30');
  // Without digits or period, none are added; another algorithm is kept.
  assert.equal(relabelTotp('otpauth://totp/x:y?secret=ABC&algorithm=SHA256', 'B', 'a@b.c'), 'otpauth://totp/B:a%40b.c?secret=ABC&issuer=B&algorithm=SHA256');
  // What is no TOTP URI with a secret comes back unchanged.
  for (const x of ['', 'not a uri', 'otpauth://hotp/x:y?secret=ABC', 'otpauth://totp/x:y?issuer=x', 'https://example.com/?secret=ABC']) assert.equal(relabelTotp(x, 'B', 'a@b.c'), x);
});

test('passkey registration options name the panel and the account, and keep the challenge and ids', () => {
  const options = { challenge: 'c1', rp: { name: 'Lightning VM', id: 'panel.example.com' }, user: { id: 'u1', name: 'Chrome · Windows · Desktop', displayName: 'Chrome · Windows · Desktop' },
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }], excludeCredentials: [{ id: 'k1' }] };
  const out = relabelRegistration(options, 'Acme Cloud', { email: 'ayse@example.com', name: 'Ayşe Yılmaz' });
  assert.deepEqual(out.rp, { name: 'Acme Cloud', id: 'panel.example.com' });
  assert.deepEqual(out.user, { id: 'u1', name: 'ayse@example.com', displayName: 'Ayşe Yılmaz' });
  assert.equal(out.challenge, 'c1');
  assert.deepEqual(out.excludeCredentials, [{ id: 'k1' }]);
  assert.equal(relabelRegistration(options, '', { email: 'a@b.c', name: '  ' }).user.displayName, 'a@b.c');
  assert.equal(relabelRegistration(options, '', { email: 'a@b.c' }).rp.name, 'Lightning VM');
});
