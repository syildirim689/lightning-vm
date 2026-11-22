// The stack's services on Admin → System: which state is a fault and which is not (a one-shot job that finished is
// not), which version each runs, which may be restarted from the panel, and what is masked in their log lines.
import test from 'node:test';
import assert from 'node:assert/strict';

const { classify, isOneShot, versionOf, builtHere, imageTag, ruleOf, checkServiceRequest, redactLine } = await import('../dist/host-services.js');

// As the agent writes them (scripts/install.sh state), from what the demo showed.
const migrate = { service: 'migrate', state: 'exited', health: '', status: 'Exited (0) 28 minutes ago', exitCode: 0, restartPolicy: 'no', awaited: 1, managed: 1, image: 'lightning-vm-api' };
const api = { service: 'api', state: 'running', health: 'healthy', status: 'Up 35 minutes (healthy)', exitCode: 0, restartPolicy: 'unless-stopped', awaited: 0, managed: 1, image: 'lightning-vm-api' };
const svc = (over) => ({ ...api, service: 'worker', ...over });

test('a one-shot job is told by its definition: restart "no", or another service waits for it to complete', () => {
  assert.equal(isOneShot(migrate), true);
  assert.equal(isOneShot({ ...migrate, restartPolicy: 'unless-stopped' }), true, 'awaited is enough');
  assert.equal(isOneShot({ ...migrate, awaited: 0 }), true, 'restart: "no" is enough');
  assert.equal(isOneShot(api), false);
  // Running without a restart policy and awaited by nobody (a simulator): a service while it runs.
  assert.equal(isOneShot({ ...api, service: 'vcsim', restartPolicy: 'no', awaited: 0 }), false);
  // Not by name: a service called migrate that is restarted like any other is a service like any other.
  assert.equal(isOneShot({ ...migrate, restartPolicy: 'always', awaited: 0 }), false);
});

test('a one-shot job that ended with 0 is completed, not a fault; any other end is', () => {
  assert.deepEqual(classify(migrate), { kind: 'completed', fault: false, oneShot: true, exitCode: 0 });
  assert.deepEqual(classify({ ...migrate, exitCode: 1, status: 'Exited (1) 2 minutes ago' }), { kind: 'failed', fault: true, oneShot: true, exitCode: 1 });
  // A long-running service that ended, even with 0, is down.
  assert.deepEqual(classify(svc({ state: 'exited', status: 'Exited (0) 1 minute ago' })), { kind: 'stopped', fault: true, oneShot: false, exitCode: 0 });
  assert.deepEqual(classify(svc({ state: 'exited', exitCode: 137, status: 'Exited (137) 1 minute ago' })), { kind: 'failed', fault: true, oneShot: false, exitCode: 137 });
  assert.equal(classify(svc({ state: 'dead', exitCode: 0 })).kind, 'failed');
  // Made but not run yet: a fault for a service, not for a one-shot job.
  assert.deepEqual([classify(svc({ state: 'created' })).fault, classify({ ...migrate, state: 'created' }).fault], [true, false]);
});

test('running states: healthy, starting, unhealthy, a restart loop, paused', () => {
  assert.deepEqual([classify(api).kind, classify(api).fault], ['healthy', false]);
  assert.deepEqual([classify(svc({ health: '' })).kind, classify(svc({ health: '' })).fault], ['running', false]);
  assert.deepEqual([classify(svc({ health: 'starting' })).kind, classify(svc({ health: 'starting' })).fault], ['starting', false]);
  assert.deepEqual([classify(svc({ health: 'unhealthy' })).kind, classify(svc({ health: 'unhealthy' })).fault], ['unhealthy', true]);
  assert.deepEqual([classify(svc({ state: 'restarting', health: '' })).kind, classify(svc({ state: 'restarting' })).fault], ['restarting', true]);
  assert.deepEqual([classify(svc({ state: 'paused' })).kind, classify(svc({ state: 'paused' })).fault], ['paused', true]);
  assert.equal(classify(svc({ state: 'something-new' })).fault, true, 'an unknown state is not hidden');
});

test('a snapshot from an older agent (no exit code, no definition) still reads the exit code from the status', () => {
  const old = { service: 'migrate', state: 'exited', health: '', status: 'Exited (0) 28 minutes ago' };
  assert.equal(classify(old).exitCode, 0);
  assert.equal(classify({ ...old, status: 'Exited (2) 1 minute ago' }).exitCode, 2);
  assert.equal(classify({ ...old, status: 'Exited (2) 1 minute ago' }).fault, true);
});

test('versions: the panel version for what is built here, the tag or the label for published images, never "unknown" with a tag', () => {
  const build = { version: 'v0.5.1-4-gabc1234', commit: 'abc1234' };
  for (const image of ['lightning-vm-api', 'lightning-e2e-worker', 'sha256:69240777abed', '', undefined]) assert.equal(builtHere(image), true, String(image));
  for (const image of ['postgres:17-alpine', 'caddy:2-alpine', 'prom/prometheus:v3.2.1', 'grafana/grafana', 'registry.example:5000/x/y:1.2']) assert.equal(builtHere(image), false, image);
  assert.deepEqual(versionOf(api, build), { panel: true, version: 'v0.5.1-4-gabc1234', commit: 'abc1234' });
  assert.deepEqual(versionOf({ ...api, service: 'postgres', image: 'postgres:17-alpine' }, build, { postgres: '17.2' }), { panel: false, tag: '17-alpine', label: '', reported: '17.2' });
  assert.deepEqual(versionOf({ ...api, service: 'proxy', image: 'caddy:2-alpine', imageVersion: 'v2.10.0' }, build), { panel: false, tag: '2-alpine', label: 'v2.10.0', reported: '' });
  assert.equal(versionOf({ ...api, service: 'x', image: 'caddy:2', imageVersion: '<no value>' }, build).label, '');
  assert.deepEqual(['prom/prometheus:v3.2.1', 'registry.example:5000/x/y', 'grafana/grafana', 'redis:7-alpine@sha256:abc'].map(imageTag), ['v3.2.1', 'latest', 'latest', '7-alpine']);
});

test('what may be done from the panel, per service', () => {
  assert.deepEqual(ruleOf(svc({})), { restart: true, run: false, refused: '', interrupts: 'operations' });
  for (const name of ['api', 'web', 'proxy']) assert.deepEqual(ruleOf(svc({ service: name })), { restart: true, run: false, refused: '', interrupts: 'panel' }, name);
  assert.equal(ruleOf(svc({ service: 'terminal' })).interrupts, 'terminal');
  assert.equal(ruleOf(svc({ service: 'grafana', image: 'grafana/grafana:11.6.0' })).interrupts, 'none');
  for (const name of ['postgres', 'redis']) assert.deepEqual(ruleOf(svc({ service: name })), { restart: false, run: false, refused: 'SERVICE_PROTECTED', interrupts: 'panel' }, name);
  assert.deepEqual(ruleOf(migrate), { restart: false, run: true, refused: '', interrupts: 'none' });
  // Another one-shot job: not run again from the panel (running it twice is not known to be harmless).
  assert.deepEqual(ruleOf({ ...migrate, service: 'seed' }), { restart: false, run: false, refused: 'SERVICE_ONE_SHOT', interrupts: 'none' });
  // Outside the compose file the agent runs (a simulator overlay): nothing.
  assert.equal(ruleOf(svc({ service: 'vcsim-esxi', managed: 0 })).refused, 'SERVICE_NOT_MANAGED');
});

test('a request names a service of the snapshot (an allow-list) and an act the rules allow; nothing else passes', () => {
  const services = [api, migrate, svc({}), svc({ service: 'postgres' }), svc({ service: 'vcsim-esxi', managed: 0 })];
  assert.deepEqual(checkServiceRequest(services, 'worker', 'restart'), { ok: true, service: 'worker', act: 'restart' });
  assert.deepEqual(checkServiceRequest(services, 'api', 'restart'), { ok: true, service: 'api', act: 'restart' });
  assert.deepEqual(checkServiceRequest(services, 'migrate', 'run'), { ok: true, service: 'migrate', act: 'run' });
  for (const [name, act, code] of [['postgres', 'restart', 'SERVICE_PROTECTED'], ['migrate', 'restart', 'SERVICE_ONE_SHOT'], ['worker', 'run', 'SERVICE_NOT_ONE_SHOT'], ['vcsim-esxi', 'restart', 'SERVICE_NOT_MANAGED']]) {
    const r = checkServiceRequest(services, name, act);
    assert.deepEqual([r.ok, r.status, r.code], [false, 409, code], `${name} ${act}`);
  }
  for (const name of ['worker; reboot', '../api', 'API', '', ' worker', 'worker\nact=run', 7, null, 'a'.repeat(42)]) {
    const r = checkServiceRequest(services, name, 'restart');
    assert.deepEqual([r.ok, r.status, r.fields], [false, 400, { service: 'INVALID_VALUE' }], JSON.stringify(name));
  }
  assert.deepEqual(checkServiceRequest(services, 'grafana', 'restart').fields, { service: 'UNKNOWN_SERVICE' }, 'a well-formed name that is not in the snapshot');
  for (const act of ['stop', 'rm', '', undefined, 'restart; ls']) assert.deepEqual(checkServiceRequest(services, 'worker', act).fields, { act: 'INVALID_VALUE' }, String(act));
  assert.deepEqual(checkServiceRequest(null, 'worker', 'restart'), { ok: false, status: 409, code: 'HOST_STATE_MISSING' }, 'no snapshot, nothing to check against');
});

test('log lines: what looks like a secret is masked, the rest of the line is kept', () => {
  const cases = [
    ['GET /x Authorization: Bearer abcdef0123456789', 'GET /x Authorization: Bearer [masked]'],
    ['{"authorization":"Basic dXNlcjpwYXNz","path":"/"}', '{"authorization":"Basic [masked]","path":"/"}'],
    ['curl -H "Authorization: token ghp_abcdefghijklmnop"', 'curl -H "Authorization: token [masked]"'],
    ['sent Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlX2hlcmU', 'sent Bearer [masked]'],
    ['cookie: lvm.session_token=abc.def; theme=dark', 'cookie: [masked]'],
    ['connecting to postgresql://lightning:s3cr3t-P4ss@postgres:5432/lightning', 'connecting to postgresql://lightning:[masked]@postgres:5432/lightning'],
    ['redis://default:hunter2@redis:6379/0 ready', 'redis://default:[masked]@redis:6379/0 ready'],
    ['POSTGRES_PASSWORD=supersecret starting', 'POSTGRES_PASSWORD=[masked] starting'],
    ['{"level":"info","password":"hunter2","user":"a"}', '{"level":"info","password":"[masked]","user":"a"}'],
    ["config api_key: 'sk-live-123456' loaded", "config api_key: '[masked]' loaded"],
    ['client_secret=abc&x=1', 'client_secret=[masked]&x=1'],
    ['GET /reset-password/abcdef123 200', 'GET /reset-password/[masked] 200'],
    ['GET /api/auth/callback?code=xyz&state=abc 302', 'GET /api/auth/callback?code=[masked]&state=[masked] 302'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlX2hlcmU seen', 'jwt [masked] seen'],
    ['-----BEGIN PRIVATE KEY-----MIIEvQIBADANBg-----END PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----[masked]-----END PRIVATE KEY-----'],
  ];
  for (const [line, want] of cases) assert.equal(redactLine(line), want, line);
  // Ordinary lines stay as they are.
  for (const line of ['2026-11-22T19:47:55Z api listening on :4000', 'migration 120_resize applied', 'GET /api/servers?page=2 200 12ms', 'tokens used: 5', 'password reset requested']) assert.equal(redactLine(line), line);
});
