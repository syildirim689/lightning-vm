// Support help against real PostgreSQL and Redis. Staff get the closed tickets most like the one in front of them, with
// the public answer that closed each (never an internal note) and the words shared. A customer writing a new ticket
// gets suggestions from their own answered tickets and from the public status page only: another customer's ticket,
// however similar, never comes back, and with the status page off no incident does.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');
const { runMigrations } = await import('../../dist/migrate.js');
const { notificationQueue } = await import('../../dist/notify.js');

let app, admin, a, b, dep, ssh, bill, theirs;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, url, cookie, payload) => app.inject({ method, url, payload, headers: { ...csrf, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (url, cookie) => call('GET', url, cookie);
const post = (url, payload, cookie) => call('POST', url, cookie, payload);
const put = (url, payload, cookie) => call('PUT', url, cookie, payload);
const freshLimits = async () => { for (const k of await redis.keys('rl:*')) await redis.del(k); };
const signUp = async (email) => { await freshLimits(); const r = await post('/auth/sign-up/email', { name: '', email, password }); assert.equal(r.statusCode, 200, r.body); return cookieOf(r); };
const open = async (cookie, subject, body) => { const r = await post('/support/tickets', { subject, body, departmentId: dep }, cookie); assert.equal(r.statusCode, 201, r.body); return r.json().id; };
const answer = async (id, body, extra = {}) => assert.equal((await post(`/support/tickets/${id}/messages`, { body, ...extra }, admin)).statusCode, 201);
const close = async (id) => assert.equal((await post(`/support/tickets/${id}/close`, {}, admin)).statusCode, 200);
const suggest = async (cookie, subject, body) => { const r = await post('/support/suggestions', { subject, body }, cookie); assert.equal(r.statusCode, 200, r.body); return r.json(); };
const sshText = ['SSH ile bağlanamıyorum', 'Sunucuya ssh ile bağlanınca connection refused hatası alıyorum, port 22 kapalı görünüyor.'];

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const { token } = await issueBootstrapToken();
  assert.equal((await post('/setup/admin', { token, email: 'boss@example.test', password })).statusCode, 201);
  admin = cookieOf(await post('/auth/sign-in/email', { email: 'boss@example.test', password }));
  await put('/admin/settings', { registrationOpen: true }, admin);
  a = await signUp('a@example.test');
  b = await signUp('b@example.test');
  dep = (await get('/support/departments', a)).json().departments[0].id;
  // a's two closed tickets, each answered by support; the first also carries an internal note written after the answer.
  ssh = await open(a, 'SSH bağlantısı kurulamıyor', 'Sunucuya ssh ile bağlanmaya çalışınca connection refused hatası alıyorum, port 22 kapalı görünüyor.');
  await answer(ssh, 'Firewall kuralınızda 22 numaralı port kapalıydı; kuralı ekledik, SSH bağlantısı yeniden çalışıyor.');
  await answer(ssh, 'Müşteri firewall kuralını kendisi silmiş, bir daha olursa uyaralım.', { internal: true });
  await close(ssh);
  bill = await open(a, 'Fatura ödemesi yapıldı ama sunucu askıda', 'Kredi kartı ile ödeme yaptım, fatura ödendi görünüyor ama sunucu hâlâ kapalı.');
  await answer(bill, 'Ödemeniz bankadan geç ulaştı; fatura kapatıldı ve sunucunuz açıldı.');
  await close(bill);
  // b's open ticket about the same thing as a's first.
  theirs = await open(b, 'SSH port 22 connection refused', 'Sunucuma SSH ile bağlanamıyorum, connection refused diyor. Port kapalı mı?');
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('staff: the closed ticket most like this one, with its public answer and the shared words; not for customers', async () => {
  assert.equal((await get(`/admin/support/tickets/${theirs}/similar`)).statusCode, 401);
  assert.equal((await get(`/admin/support/tickets/${theirs}/similar`, b)).statusCode, 403);
  assert.equal((await get(`/admin/support/tickets/${randomUUID()}/similar`, admin)).statusCode, 404);
  const r = (await get(`/admin/support/tickets/${theirs}/similar`, admin)).json();
  assert.equal(r.compared, 2);
  assert.deepEqual(r.similar.map((s) => s.id), [ssh], 'the invoice ticket shares nothing with it');
  const [s] = r.similar;
  assert.deepEqual([s.subject, typeof s.number, s.rating], ['SSH bağlantısı kurulamıyor', 'number', null]);
  assert.match(s.answer, /^Firewall kuralınızda 22 numaralı port kapalıydı/, 'the answer the customer got');
  assert.doesNotMatch(s.answer, /kendisi silmiş/, 'never the internal note');
  for (const w of ['ssh', 'refused', 'port']) assert.ok(s.shared.includes(w), `shares ${w}: ${s.shared}`);
  assert.ok(s.score > 0.2 && s.score <= 1);
  // The ticket itself and tickets still open are not offered: seen from a's closed one, b's open one is not there.
  assert.deepEqual((await get(`/admin/support/tickets/${ssh}/similar`, admin)).json().similar, []);
});

test('a customer is offered their own answered tickets and nobody else\'s', async () => {
  assert.equal((await post('/support/suggestions', { subject: sshText[0], body: sshText[1] })).statusCode, 401);
  const mine = await suggest(a, ...sshText);
  assert.deepEqual(mine.answers.map((x) => [x.id, x.subject, x.status]), [[ssh, 'SSH bağlantısı kurulamıyor', 'closed']]);
  assert.match(mine.answers[0].answer, /^Firewall kuralınızda/);
  assert.doesNotMatch(JSON.stringify(mine), /kendisi silmiş/);
  assert.ok(mine.answers[0].shared.includes('ssh'));
  // b wrote nearly the same words as a's closed ticket, and has an open ticket of their own without an answer: nothing.
  const other = await suggest(b, ...sshText);
  assert.deepEqual(other.answers, []);
  assert.doesNotMatch(JSON.stringify(other), /Firewall|bağlantısı kurulamıyor/);
  // Once support answers b's own ticket, that one is offered to b (and still not a's).
  await answer(theirs, 'Sizin sunucunuzda SSH servisi durmuştu, yeniden başlattık.');
  assert.deepEqual((await suggest(b, ...sshText)).answers.map((x) => x.id), [theirs]);
  // Too little to compare, and a text about something else: nothing.
  assert.deepEqual(await suggest(a, 'ssh', ''), { incidents: [], answers: [] });
  assert.deepEqual((await suggest(a, 'Alan adı yönlendirmesi', 'Nameserver kayıtlarını nasıl değiştiririm?')).answers, []);
});

test('incidents of the public status page: open ones always, resolved ones when about the same thing, none with the page off', async () => {
  const made = await post('/admin/incidents', { title: 'İstanbul lokasyonunda ağ kesintisi', impact: 'major', status: 'investigating', body: 'Bazı sunuculara erişilemiyor, inceliyoruz.' }, admin);
  assert.equal(made.statusCode, 201, made.body);
  const solved = await post('/admin/incidents', { title: 'SSH bağlantı sorunu', impact: 'minor', status: 'resolved', body: 'Port 22 üzerinden ssh bağlantıları connection refused veriyordu; firewall kuralı düzeltildi.' }, admin);
  assert.equal(solved.statusCode, 201, solved.body);
  const unrelated = await post('/admin/incidents', { title: 'Fatura e-postaları gecikti', impact: 'minor', status: 'resolved', body: 'E-posta kuyruğu boşaltıldı.' }, admin);
  assert.equal(unrelated.statusCode, 201, unrelated.body);
  const r = await suggest(b, ...sshText);
  assert.deepEqual(r.incidents.map((i) => [i.id, i.open]), [[made.json().id, true], [solved.json().id, false]]);
  assert.deepEqual(Object.keys(r.incidents[0]).sort(), ['createdAt', 'id', 'impact', 'open', 'resolvedAt', 'status', 'title']);
  assert.equal((await put('/admin/settings/status-page', { enabled: false }, admin)).statusCode, 200);
  assert.deepEqual((await suggest(b, ...sshText)).incidents, [], 'not public any more');
  assert.equal((await put('/admin/settings/status-page', { enabled: true }, admin)).statusCode, 200);
});
