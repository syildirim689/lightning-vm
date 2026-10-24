// Root passwords: weak ones are replaced by a branded strong one; the guest gets a SHA-512 crypt hash.
import test from 'node:test';
import assert from 'node:assert/strict';

const { isWeak, generatePassword, choosePassword, sha512Crypt } = await import('../dist/passwords.js');

test('SHA-512 crypt matches the specification test vectors', () => {
  // From Drepper's "Unix crypt using SHA-256 and SHA-512" (rounds=5000 default).
  assert.equal(sha512Crypt('Hello world!', 'saltstring'), '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1');
  assert.match(sha512Crypt('x'), /^\$6\$[A-Za-z0-9./]{1,16}\$[A-Za-z0-9./]{86}$/);
});

test('weak passwords are recognised; strong ones are kept', () => {
  for (const p of ['short1!', 'alllowercaseletters', 'Password123!', 'Qwerty123456!', 'Aaaaaa1!aaaa', 'Galatasaray1905!', 'web-1-Server!2026']) {
    assert.equal(isWeak(p, ['web-1', 'ayse']), true, p);
  }
  assert.equal(isWeak('Tr0ub4dor&3-horse-Battery', ['web-1']), false);
  assert.deepEqual(choosePassword('Tr0ub4dor&3-horse-Battery', 'Acme', []), { password: 'Tr0ub4dor&3-horse-Battery', replaced: false });
  assert.equal(choosePassword(undefined, 'Acme', []), null);
});

test('a weak password becomes a strong branded one', () => {
  const r = choosePassword('123456', 'Lightning VM!', ['web-1']);
  assert.equal(r.replaced, true);
  assert.match(r.password, /^LightningVM(-[A-Za-z2-9]{4}){4}$/);
  assert.equal(isWeak(r.password), false);
  assert.notEqual(generatePassword('Acme'), generatePassword('Acme'));
});
