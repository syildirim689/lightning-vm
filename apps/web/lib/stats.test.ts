import test from 'node:test';
import assert from 'node:assert/strict';
import { highlights, seriesCsv } from './stats.ts';

const p = (at: string, created = 0, deleted = 0) => ({ at, created, deleted, signups: 0, ticketsOpened: 0, ticketsClosed: 0, opsOk: 0, opsFailed: 0 });
const none = { value: 0, change: 0 };

test('highlights: failures first, then support load and growth, at most four', () => {
  const h = highlights({ signups: { value: 12, change: 50 }, tickets: { value: 9, change: 80 }, servers: none, successRate: { value: 90, change: -5 } }, [p('2026-10-01', 3), p('2026-10-02', 5, 1)]);
  assert.deepEqual(h.map((x) => x.key), ['failures', 'ticketsUp', 'signupsUp', 'growth']);
  assert.equal(h[0].values.rate, 10);
  assert.equal(h[3].values.n, 7);
});

test('highlights: small changes say nothing; the busiest day stands out; an empty period is quiet', () => {
  const ok = { value: 100, change: 0 };
  assert.deepEqual(highlights({ signups: { value: 1, change: 10 }, tickets: { value: 1, change: null }, servers: none, successRate: { value: null, change: null } }, [p('2026-10-01')]).map((x) => x.key), ['quiet']);
  // As many created as deleted: no growth line, but the busiest day.
  assert.deepEqual(highlights({ signups: none, tickets: none, servers: none, successRate: ok }, [p('a', 1), p('b', 4), p('c', 2, 7)]).map((x) => [x.key, x.values]), [['peakDay', { at: 'b', n: 4 }]]);
});

test('CSV: a header, one row per day, fields quoted when needed', () => {
  assert.equal(seriesCsv([p('2026-10-01', 2, 1)], ['Day', 'Created, new', 'Deleted', 'a', 'b', 'c', 'd', 'e']),
    'Day,"Created, new",Deleted,a,b,c,d,e\r\n2026-10-01,2,1,0,0,0,0,0\r\n');
});
