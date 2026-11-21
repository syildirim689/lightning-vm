// The month-end cost forecast and the budget against it, on real PostgreSQL and Redis: servers billed by the hour count
// with the usage billing recorded this month (also that of servers deleted since) plus their rate for the hours left;
// a budget the monthly run rate stays under can still be passed by that forecast, which is said in the summary, as an
// insight and once a month as a notice; the periodic check only looks at accounts with a budget not yet warned.
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
const { notificationQueue, catalog } = await import('../../dist/notify.js');
const { encryptSecret } = await import('../../dist/secrets.js');
const { runBudgetForecasts } = await import('../../dist/cost-forecast.js');
const { today } = await import('../../dist/billing.js');

let app, admin, a, aId, b, bId, site;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, url, cookie, payload) => app.inject({ method, url, payload, headers: { ...csrf, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (url, cookie) => call('GET', url, cookie);
const post = (url, payload, cookie) => call('POST', url, cookie, payload);
const put = (url, payload, cookie) => call('PUT', url, cookie, payload);
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const freshLimits = async () => { for (const k of await redis.keys('rl:*')) await redis.del(k); };
const signUp = async (email) => { await freshLimits(); const r = await post('/auth/sign-up/email', { name: '', email, password }); assert.equal(r.statusCode, 200, r.body); return [cookieOf(r), r.json().user.id]; };
const server = async (ownerId, name, extra = {}) => {
  const cols = { owner_id: ownerId, pool_id: site.pool, image_id: site.image, name, vcpu: 2, memory_mb: 2048, disk_gb: 20, price_monthly: '300.00', currency: 'TRY', state: 'ready', power_state: 'poweredOn', vm_moref: `vm-${name}`,
    created_at: new Date(Date.now() - 90 * 86_400_000), ...extra };
  const names = Object.keys(cols);
  return (await one(`INSERT INTO servers (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols))).id;
};
const month = () => `${today().slice(0, 7)}-01`;
const usage = (serverId, ownerId, hours, amount) => pool.query('INSERT INTO server_usage (server_id, owner_id, month, hours, amount, currency) VALUES ($1, $2, $3, $4, $5, $6)', [serverId, ownerId, month(), hours, amount, 'TRY']);
const hoursLeft = () => { const n = new Date(); return Math.floor((Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1) - n.getTime()) / 3_600_000); };
const near = (x, y, what) => assert.ok(Math.abs(x - y) <= 0.51, `${what}: ${x} is not about ${y}`); // an hour may begin between the two readings
const notices = async (userId) => (await notificationQueue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed'])).filter((j) => j.data?.event === 'billing.budget_forecast' && j.data.to?.[0] === userId);
const summary = async (cookie) => (await get('/usage/summary', cookie)).json();
const cards = async (cookie) => (await get('/insights', cookie)).json().insights.filter((i) => i.code.startsWith('BUDGET_FORECAST'));

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
  [a, aId] = await signUp('a@example.test');
  [b, bId] = await signUp('b@example.test');
  const conn = randomUUID();
  await pool.query(`INSERT INTO vmware_connections (id, name, kind, host, username, password_enc, tls_mode, product, write_api)
    VALUES ($1, 'it-forecast', 'esxi', 'esxi.forecast.test', 'root', $2, 'system', '{}', 'unknown')`, [conn, encryptSecret('pw', 'not-this-connection')]);
  const rp = await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref) VALUES ('it-forecast', $1, 'ha-1', '{ds-1}', 'net-1') RETURNING id`, [conn]);
  const img = await one(`INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ('it-forecast', 'linux', $1, 'tpl-1') RETURNING id`, [conn]);
  site = { pool: rp.id, image: img.id };
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('monthly servers alone forecast as before; hourly ones count with recorded usage and the rate for the hours left', async () => {
  assert.equal((await get('/usage/summary')).statusCode, 401);
  assert.deepEqual([(await summary(a)).costs, (await summary(a)).budget], [[], null]);
  await server(aId, 'monthly-1');
  const [m] = (await summary(a)).costs;
  assert.deepEqual([m.currency, m.monthly, m.forecast, m.hourly], ['TRY', 300, 300, null]);
  assert.ok(m.accrued > 0 && m.accrued <= 300);

  // One hourly server that runs (100 hours recorded), one deleted this month (40 hours, still to be paid for), one
  // held for an empty balance and switched off (builds no usage: its rate is not projected).
  const run = await server(aId, 'hourly-1', { billing_mode: 'hourly', price_hourly: '0.5000', price_monthly: '365.00' });
  const gone = await server(aId, 'hourly-gone', { billing_mode: 'hourly', price_hourly: '0.5000', price_monthly: '365.00', state: 'deleted' });
  await server(aId, 'hourly-held', { billing_mode: 'hourly', price_hourly: '9.0000', price_monthly: '6570.00', billing_hold: true, power_state: 'poweredOff' });
  await usage(run, aId, 100, 50);
  await usage(gone, aId, 40, 20);
  // Another customer's usage is theirs.
  const theirs = await server(bId, 'theirs', { billing_mode: 'hourly', price_hourly: '2.0000', price_monthly: '1460.00' });
  await usage(theirs, bId, 10, 20);
  const [c] = (await summary(a)).costs;
  assert.deepEqual([c.hourly.accrued, c.hourly.hours, c.hourly.perHour], [70, 140, 0.5]);
  near(c.hourly.forecast, 70 + 0.5 * hoursLeft(), 'hourly forecast');
  near(c.forecast, 300 + 70 + 0.5 * hoursLeft(), 'forecast');
  near(c.accrued, m.accrued + 70, 'accrued');
  assert.equal(c.monthly, 300 + 365 + 6570, 'the monthly total lists every server that exists');
  const [o] = (await summary(b)).costs;
  assert.deepEqual([o.hourly.accrued, o.hourly.hours, o.hourly.perHour], [20, 10, 2]);
});

test('a budget the run rate stays under is passed by the forecast: said in the summary, as an insight and once as a notice', async () => {
  // b: 1460 a month by list price; 5000 already spent this month on a server deleted since.
  const spent = await server(bId, 'spent', { billing_mode: 'hourly', price_hourly: '2.0000', price_monthly: '1460.00', state: 'deleted' });
  await usage(spent, bId, 2500, 5000);
  const set = await put('/usage/budget', { amount: '3000', currency: 'TRY' }, b);
  assert.equal(set.statusCode, 200, set.body);
  const budget = set.json().budget;
  assert.deepEqual([budget.amount, budget.monthly, budget.state, budget.forecastState], [3000, 1460, 'ok', 'over']);
  near(budget.forecast, 5020 + 2 * hoursLeft(), 'budget forecast');
  assert.ok(budget.forecastRatio > 1);
  assert.deepEqual((await summary(b)).budget.forecastState, 'over');
  // Told at once, once.
  const [n, ...more] = await notices(bId);
  assert.equal(more.length, 0);
  assert.deepEqual([n.data.data.amount, n.data.data.currency, n.data.data.accrued], ['3000.00', 'TRY', '5020.00']);
  for (const l of ['tr', 'en']) { const text = catalog['billing.budget_forecast'].text[l](n.data.data); assert.match(text.body, /3000\.00 TRY/); assert.match(text.body, /5020\.00 TRY/); }
  assert.equal((await one('SELECT budget_forecast_alerted AS m FROM users WHERE id = $1', [bId])).m, new Date().toISOString().slice(0, 7));
  const [card] = await cards(b);
  assert.deepEqual([card.code, card.severity, card.link, card.key, card.params.amount, card.params.currency], ['BUDGET_FORECAST_OVER', 'warning', '/', `budget-forecast:${new Date().toISOString().slice(0, 7)}`, '3000.00', 'TRY']);
  assert.ok(card.params.pct > 100);

  // The periodic run does not repeat it, and passes over accounts without a budget.
  assert.deepEqual(await runBudgetForecasts(), { checked: 0, warned: 0 });
  assert.equal((await notices(bId)).length, 1);
  // A changed budget may be warned about again; one the forecast stays under is checked and left alone.
  assert.equal((await put('/usage/budget', { amount: '4000', currency: 'TRY' }, b)).json().budget.forecastState, 'over');
  assert.equal((await notices(bId)).length, 2);
  const roomy = (await put('/usage/budget', { amount: '900000', currency: 'TRY' }, b)).json().budget;
  assert.deepEqual([roomy.state, roomy.forecastState], ['ok', 'ok']);
  assert.deepEqual(await cards(b), []);
  assert.deepEqual(await runBudgetForecasts(), { checked: 1, warned: 0 });
  assert.equal((await notices(bId)).length, 2);
  // Close to the budget: the insight says so; no notice for "close".
  const f = (await summary(b)).budget.forecast;
  const close = (await put('/usage/budget', { amount: String(Math.ceil(f / 0.9)), currency: 'TRY' }, b)).json().budget;
  assert.equal(close.forecastState, 'near');
  assert.deepEqual((await cards(b)).map((x) => x.code), ['BUDGET_FORECAST_NEAR']);
  assert.equal((await notices(bId)).length, 2);
  // The run finds an account whose month went over without it changing anything itself (usage grew).
  await pool.query("UPDATE server_usage SET amount = amount + 100000 WHERE owner_id = $1 AND server_id = $2", [bId, spent]);
  assert.deepEqual(await runBudgetForecasts(), { checked: 1, warned: 1 });
  assert.equal((await notices(bId)).length, 3);
  assert.deepEqual(await runBudgetForecasts(), { checked: 0, warned: 0 });
  // Removed: nothing is compared any more.
  assert.equal((await put('/usage/budget', { amount: null }, b)).json().budget, null);
  assert.deepEqual(await cards(b), []);
  assert.equal((await one('SELECT budget_forecast_alerted AS m FROM users WHERE id = $1', [bId])).m, null);
});

test('in a month in which "budget exceeded" went out, the forecast is not announced on top of it', async () => {
  // a: run rate 300 + 365 + 6570 a month, and at least 370 this month whatever the day; a budget of 100 is exceeded by both.
  const set = (await put('/usage/budget', { amount: '100', currency: 'TRY' }, a)).json().budget;
  assert.deepEqual([set.state, set.forecastState], ['over', 'over']);
  assert.equal((await one('SELECT budget_alerted AS m FROM users WHERE id = $1', [aId])).m, new Date().toISOString().slice(0, 7));
  assert.equal((await notices(aId)).length, 0);
  assert.deepEqual(await runBudgetForecasts(), { checked: 0, warned: 0 });
  assert.deepEqual((await cards(a)).map((x) => x.code), ['BUDGET_FORECAST_OVER']);
});

test('the periodic run looks at every account with a budget, page after page', async () => {
  const { BUDGET_FORECAST_PAGE } = await import('../../dist/cost-forecast.js');
  assert.equal(BUDGET_FORECAST_PAGE, 500);
  await pool.query('UPDATE users SET budget_monthly = NULL, budget_currency = NULL');
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await signUp(`page-${i}@example.test`))[1]);
  // Budgets nobody is near: such accounts are not marked, so the next run meets them again.
  await pool.query("UPDATE users SET budget_monthly = 900000, budget_currency = 'TRY' WHERE id = ANY($1::uuid[])", [ids]);
  assert.deepEqual(await runBudgetForecasts(new Date(), 2), { checked: 5, warned: 0 }, 'pages of two: all five are reached');
  assert.deepEqual(await runBudgetForecasts(new Date(), 5), { checked: 5, warned: 0 }, 'a last page that is exactly full');
  assert.deepEqual(await runBudgetForecasts(), { checked: 5, warned: 0 });
});
