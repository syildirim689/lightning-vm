// TEST ONLY. Fills the throw-away test database with a realistic amount of usage history, so that the roll-up, the
// usage watch, the schedule suggestion, the quietest hours and the insights can be measured and checked against more
// than a handful of rows: by default 200 servers with 14 days of five-minute CPU samples (about 800 000 rows, what
// the worker keeps), four weeks of hourly rows and 16 days of traffic. Never point it at a real database: the callers
// are the integration tests, which refuse any database not named *_test.
//
// Every server has one of five shapes of use, repeated in order, so results can be predicted:
//   0 office     busy 08:00-17:59 UTC on working days (35-50 %), idle otherwise
//   1 flat       20-24 % around the clock
//   2 batch      80-90 % from 01:00 to 03:59 UTC every night, 5-7 % otherwise
//   3 idle       under 1 % always
//   4 web        a daily wave between 5 % and 45 %, highest at 14:00 UTC
import { randomUUID } from 'node:crypto';

export const SHAPES = ['office', 'flat', 'batch', 'idle', 'web'];

// CPU percent of a shape at a moment (SQL): `t` a timestamptz expression, `shape` an int expression, `noise` 0..1.
const cpuSql = (t, shape, noise) => `(CASE ${shape}
  WHEN 0 THEN CASE WHEN EXTRACT(ISODOW FROM ${t} AT TIME ZONE 'UTC') <= 5 AND EXTRACT(HOUR FROM ${t} AT TIME ZONE 'UTC') BETWEEN 8 AND 17 THEN 35 + 15 * ${noise} ELSE 0.3 + ${noise} END
  WHEN 1 THEN 20 + 4 * ${noise}
  WHEN 2 THEN CASE WHEN EXTRACT(HOUR FROM ${t} AT TIME ZONE 'UTC') BETWEEN 1 AND 3 THEN 80 + 10 * ${noise} ELSE 5 + 2 * ${noise} END
  WHEN 3 THEN 0.2 + 0.6 * ${noise}
  ELSE 25 + 18 * sin((EXTRACT(HOUR FROM ${t} AT TIME ZONE 'UTC') - 8) / 24.0 * 2 * pi()) + 2 * ${noise} END)`;

// One connection (a kind that reports CPU figures unless told otherwise), a resource pool and an image on it.
export async function seedSite(pool, encryptSecret, { name = 'seed', kind = 'esxi' } = {}) {
  const connection = randomUUID();
  await pool.query(`INSERT INTO vmware_connections (id, name, kind, host, username, password_enc, tls_mode, product, write_api)
    VALUES ($1, $2, $3, $4, 'root', $5, 'system', '{}', 'unknown')`, [connection, `it-${name}`, kind, `${name}.seed.test`, encryptSecret('pw', 'not-this-connection')]);
  const { rows: [rp] } = await pool.query(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref) VALUES ($1, $2, 'ha-1', '{ds-1}', 'net-1') RETURNING id`, [`it-${name}`, connection]);
  const { rows: [img] } = await pool.query(`INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ($1, 'linux', $2, 'tpl-1') RETURNING id`, [`it-${name}`, connection]);
  return { connection, pool: rp.id, image: img.id };
}

// `count` ready, running servers spread over the owners given (round robin), 2 vCPUs each; shape = position % 5.
export async function seedServers(pool, site, owners, count = 200, prefix = 'seed') {
  const { rows } = await pool.query(`INSERT INTO servers (owner_id, pool_id, image_id, name, vcpu, memory_mb, disk_gb, price_monthly, currency, state, power_state, vm_moref, created_at)
    SELECT ($1::uuid[])[1 + (n % cardinality($1::uuid[]))], $2, $3, $4 || '-' || lpad(n::text, 4, '0'), 2, 2048, 20, 80, 'TRY', 'ready', 'poweredOn', 'vm-' || $4 || '-' || n, now() - interval '60 days'
    FROM generate_series(0, $5::int - 1) n RETURNING id, name`, [owners, site.pool, site.image, prefix, count]);
  return rows.sort((x, y) => x.name.localeCompare(y.name)).map((r, i) => ({ id: r.id, name: r.name, shape: i % SHAPES.length }));
}

// Five-minute samples of the last `days` days, as the worker's power sampling writes them (and keeps for 14 days).
export async function seedSamples(pool, servers, days = 14) {
  await pool.query('SELECT setseed(0.42)');
  const { rowCount } = await pool.query(`INSERT INTO server_cpu_samples (server_id, at, cpu_pct)
    SELECT s.id, t, round(${cpuSql('t', 's.shape', 'random()')}::numeric, 2)
    FROM unnest($1::uuid[], $2::int[]) s(id, shape), generate_series(now() - make_interval(days => $3), now(), interval '5 minutes') t
    ON CONFLICT DO NOTHING`, [servers.map((s) => s.id), servers.map((s) => s.shape), days]);
  return rowCount;
}

// Hourly rows from `fromDays` to `toDays` days ago (complete hours), as the roll-up would have left them. With
// toDays = 0 they reach the last complete hour; give toDays = 14 to add the weeks the samples no longer cover.
export async function seedHourly(pool, servers, fromDays = 28, toDays = 0) {
  const { rowCount } = await pool.query(`INSERT INTO server_cpu_hourly (server_id, hour, avg_pct, max_pct, samples)
    SELECT s.id, h, round(${cpuSql('h', 's.shape', '0.5')}::numeric, 2), round(${cpuSql('h', 's.shape', '1.0')}::numeric, 2), 12
    FROM unnest($1::uuid[], $2::int[]) s(id, shape),
      generate_series(date_trunc('hour', now(), 'UTC') - make_interval(days => $3), date_trunc('hour', now(), 'UTC') - make_interval(days => $4) - interval '1 hour', interval '1 hour') h
    ON CONFLICT DO NOTHING`, [servers.map((s) => s.id), servers.map((s) => s.shape), fromDays, toDays]);
  return rowCount;
}

// A traffic row per server and day for the last `days` days: between 1 and 3 GB a day, a third of it outbound.
export async function seedTraffic(pool, servers, days = 16) {
  const { rowCount } = await pool.query(`INSERT INTO server_traffic (server_id, day, rx_bytes, tx_bytes)
    SELECT s.id, d::date, (2e9 + 1e9 * sin(n + extract(doy FROM d)))::bigint * 2 / 3, (2e9 + 1e9 * sin(n + extract(doy FROM d)))::bigint / 3
    FROM unnest($1::uuid[]) WITH ORDINALITY s(id, n), generate_series(current_date - $2::int, current_date, interval '1 day') d
    ON CONFLICT DO NOTHING`, [servers.map((s) => s.id), days]);
  return rowCount;
}

// The statements a piece of work sends, counted: `await counted(pool, () => work())` gives { result, queries, ms }.
// Statements sent through a client checked out of the pool (transactions) are counted as well.
export async function counted(pool, work) {
  let queries = 0;
  const poolQuery = pool.query, connect = pool.connect;
  pool.query = function (...args) { queries++; return poolQuery.apply(this, args); };
  const clients = [];
  pool.connect = function (...args) {
    // With a callback it is pool.query's own checkout, counted above already.
    if (typeof args[0] === 'function') return connect.apply(this, args);
    return connect.apply(this, args).then((client) => {
      if (!clients.some((c) => c.client === client)) {
        const plain = client.query;
        clients.push({ client, plain });
        client.query = function (...a) { queries++; return plain.apply(this, a); };
      }
      return client;
    });
  };
  const started = performance.now();
  try { return { result: await work(), queries, ms: Math.round(performance.now() - started) }; }
  finally { pool.query = poolQuery; pool.connect = connect; for (const c of clients) c.client.query = c.plain; }
}
