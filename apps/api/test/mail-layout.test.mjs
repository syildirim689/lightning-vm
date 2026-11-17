// The e-mail layout: every value escaped, the button and code present in both versions, readable button text.
import test from 'node:test';
import assert from 'node:assert/strict';

const { eventTime, mailHtml, mailText } = await import('../dist/mail-layout.js');
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

test('the tag and tone colour the card, and the header and footer link to the panel', () => {
  const b = { ...brand('#f59e0b'), panelUrl: 'https://panel.example/', settingsUrl: 'https://panel.example/account?tab=notifications' };
  const html = mailHtml({ ...content, label: 'Yönetici <uyarısı>', tone: 'danger' }, b);
  assert.ok(html.includes('Yönetici &lt;uyarısı&gt;'));
  assert.ok(html.includes('background:#dc2626'), 'danger edge');
  assert.ok(html.includes('href="https://panel.example/account?tab=notifications"'));
  assert.ok(html.includes('Panele git'));
  assert.ok(!mailHtml(content, brand('#f59e0b')).includes('Panele git'), 'no panel link without a public address');
  assert.ok(mailText({ ...content, label: 'Sunucu' }, b).startsWith('[Sunucu]'));
});

test('the event time is formatted in the account zone with the zone named, in both languages; an unknown zone gives UTC', () => {
  const at = new Date(Date.UTC(2026, 10, 17, 9, 5));
  const tr = eventTime('tr', 'Europe/Istanbul', at), en = eventTime('en', 'America/New_York', at);
  assert.match(tr, /17 Kasım 2026/); assert.match(tr, /12:05/); assert.match(tr, /GMT\+3/);
  assert.match(en, /17 November 2026/); assert.match(en, /04:05/); assert.match(en, /GMT-5|EST/);
  assert.match(eventTime('en', null, at), /12:05/, 'no zone set: Turkey');
  for (const l of ['tr', 'en']) { const v = eventTime(l, 'Nope/Zone', at); assert.match(v, /09:05/); assert.match(v, /UTC/); }
});
