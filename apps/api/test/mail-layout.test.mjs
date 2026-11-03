// The e-mail layout: every value escaped, the button and code present in both versions, readable button text.
import test from 'node:test';
import assert from 'node:assert/strict';

const { mailHtml, mailText } = await import('../dist/mail-layout.js');
const brand = (accent) => ({ name: 'Acme <Cloud>', accent, logoUrl: null, locale: 'tr' });
const content = { preheader: 'p', heading: 'Kod "x"', intro: ['<script>alert(1)</script>'], code: '123456',
  button: { label: 'Aç', url: 'https://panel.example/a?b=1&c=2' }, details: [['IP', '192.0.2.1']], note: 'n' };

test('html escapes every value and keeps the link usable', () => {
  const html = mailHtml(content, brand('#f59e0b'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Acme &lt;Cloud&gt;'));
  assert.ok(html.includes('href="https://panel.example/a?b=1&amp;c=2"'));
  assert.ok(html.includes('123456'));
  assert.ok(html.includes('lang="tr"'));
});

test('button text is dark on the light default accent and white on a dark one', () => {
  assert.match(mailHtml(content, brand('#f59e0b')), /color:#111827;text-decoration:none/);
  assert.match(mailHtml(content, brand('#1e3a8a')), /color:#ffffff;text-decoration:none/);
});

test('the plain-text twin carries the same content', () => {
  const text = mailText(content, brand('#f59e0b'));
  for (const s of ['Kod "x"', '123456', 'Aç: https://panel.example/a?b=1&c=2', 'IP: 192.0.2.1', 'Acme <Cloud>']) assert.ok(text.includes(s), s);
});
