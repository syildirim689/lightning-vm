// Lightning VM Proxmox VE adapter: a small internal HTTP service that speaks the same contract as the VMware
// adapter (docs/adapter-contract.md), so the panel's API and worker treat a Proxmox VE node or cluster like any
// other connection. Only they call it (shared bearer token, internal Docker network). It keeps no state and never
// logs request bodies, so credentials pass through memory only.
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { connect, Failure } from './pve.mjs';
import * as h from './handlers.mjs';

const log = (level, msg, extra = {}) => console.log(JSON.stringify({ level, time: Date.now(), service: 'proxmox', msg, ...extra }));
// What each code answers with. The callers read the code; the status is for people reading logs.
const statusOf = (code) => (['VM_NOT_FOUND', 'DATASTORE_NOT_FOUND'].includes(code) ? 404
  : ['NOT_MANAGED', 'NOT_IMPORTABLE', 'DISK_HAS_SNAPSHOTS', 'DISK_SHRINK_NOT_SUPPORTED', 'INVALID_STATE', 'VM_HAS_NO_DISK', 'SYSTEM_DISK', 'NO_DISK_CONTROLLER', 'TOOLS_NOT_RUNNING'].includes(code) ? 409
  : ['INVALID_LOGIN', 'PERMISSION_DENIED', 'UNAUTHORIZED'].includes(code) ? 401
  : ['INVALID_CA', 'INVALID_PIN', 'INVALID_TLS_MODE', 'INVALID_REQUEST', 'ENDPOINT_BLOCKED', 'PROVISIONING_NOT_SUPPORTED', 'TEMPLATE_NOT_FOUND', 'NETWORK_NOT_FOUND', 'TEMPLATE_HAS_NO_NIC', 'DISK_SMALLER_THAN_TEMPLATE', 'PLATFORM_NOT_SUPPORTED'].includes(code) ? 400 : 502);

// route -> [handler, seconds allowed]
export const routes = {
  '/v1/discover': [h.discover, 60], '/v1/task': [h.task, 30], '/v1/vm/clone': [h.clone, 60], '/v1/vm/find': [h.find, 30], '/v1/vms/managed': [h.managedVms, 60],
  '/v1/vm/power': [h.powerAction, 60], '/v1/vm/destroy': [h.destroy, 120], '/v1/vm/resize': [h.resize, 60], '/v1/vm/rename': [h.rename, 60], '/v1/vm/details': [h.details, 30],
  '/v1/vm/metrics': [h.metrics, 30], '/v1/vm/snapshots': [h.snapshots, 30], '/v1/vm/snapshot': [h.snapshot, 60], '/v1/vm/disks': [h.disks, 30], '/v1/vm/disk-add': [h.diskAdd, 60],
  '/v1/vm/disk-remove': [h.diskRemove, 60], '/v1/topology': [h.topology, 60], '/v1/power': [h.powerReport, 60],
};
// In the contract, not on Proxmox VE yet: answered with one clear, permanent code rather than a timeout.
const later = ['/v1/console-ticket', '/v1/vm/disk-copy', '/v1/backup/delete', '/v1/image/create', '/v1/image/delete', '/v1/network/create', '/v1/network/delete', '/v1/vm/nic-add', '/v1/vm/nic-remove',
  '/v1/vm/nic-mac', '/v1/vm/migrate', '/v1/vm/firewall', '/v1/vm/shaping', '/v1/vm/cdrom', '/v1/iso/upload', '/v1/iso/delete', '/v1/scan'];

export function handler(token, options = {}) {
  const want = Buffer.from(token);
  return async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const path = (req.url ?? '').split('?')[0];
    if (path === '/healthz' && req.method === 'GET') return send(200, { status: 'ok' });
    const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return send(401, { code: 'UNAUTHORIZED', message: 'service token required' });
    if (later.includes(path)) return send(400, { code: 'PLATFORM_NOT_SUPPORTED', message: 'not available on Proxmox VE yet' });
    const route = routes[path];
    if (!route || req.method !== 'POST') return send(404, { code: 'INVALID_REQUEST', message: 'unknown route' });
    const started = Date.now();
    let api;
    try {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 256 * 1024) throw new Failure('INVALID_REQUEST', 'request too large'); chunks.push(c); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Failure('INVALID_REQUEST', 'the body is not JSON'); }
      const [run, seconds] = route;
      const work = (async () => { api = await connect(body, options); return run(api, body); })();
      const out = await Promise.race([work, new Promise((_, no) => setTimeout(() => no(new Failure('TIMEOUT', 'timed out')), seconds * 1000).unref())]);
      send(200, out);
    } catch (e) {
      const code = e instanceof Failure ? e.code : 'PROXMOX_ERROR';
      log(code === 'PROXMOX_ERROR' ? 'error' : 'warn', 'request_failed', { path, code, duration_ms: Date.now() - started, ...(!(e instanceof Failure) && { error: String(e?.message ?? e) }) });
      send(statusOf(code), { code, message: String(e?.message ?? code), ...(e?.certificate && { certificate: e.certificate }) });
    } finally { api?.close?.(); }
  };
}

if (process.argv[2] === 'healthcheck') {
  http.get('http://127.0.0.1:8080/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));
} else if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.mjs')) {
  let token = '';
  try { token = readFileSync(process.env.PROXMOX_SERVICE_TOKEN_FILE ?? process.env.VMWARE_SERVICE_TOKEN_FILE ?? '/run/secrets/vmware_token', 'utf8').trim(); } catch { /* reported below */ }
  if (token.length < 32) { log('error', 'service_token_missing'); process.exit(1); }
  const server = http.createServer(handler(token));
  server.listen(8080, () => log('info', 'listening', { port: 8080 }));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}
