// Reverse DNS (PTR) for the routed blocks of a colocation: PowerDNS's HTTP API holds the in-addr.arpa and
// ip6.arpa zones. New servers get the admin's default PTR, customers may set their own (optionally only when
// the name resolves back to the address), deleted servers' records are removed. The worker only queues
// ("rdns" queue); this process writes, because it holds the DNS settings and key.
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { pool, redis } from './db';
import { apiError } from './errors';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { logEvent } from './log';
import { Can, PermissionGuard } from './rbac';
import { decryptSecret, encryptSecret } from './secrets';
import { findServer } from './servers';
import { getSettings, saveSettings, type RdnsSettings } from './settings-store';
import { hostname, renderPtr, reverseName } from './rdns-names';
export { renderPtr, reverseName };

type Input = Record<string, unknown>;

const key = (s: RdnsSettings) => (s.apiKeyEnc ? decryptSecret(s.apiKeyEnc, 'settings:rdns') : '');
async function pdns(s: RdnsSettings, apiKey: string, path: string, init: RequestInit = {}) {
  const url = `${s.apiUrl.replace(/\/+$/, '')}/api/v1/servers/${encodeURIComponent(s.serverId)}${path}`;
  let res: Response;
  // The address is whatever the settings form names, and these errors also reach customers (their PTR): what it
  // answered is never passed on, only the kind of failure (the system's error code, the status class). A redirect is
  // not followed: the key would go with it.
  try {
    res = await fetch(url, { ...init, redirect: 'manual', headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    const code = String((err as { cause?: { code?: string } }).cause?.code ?? '');
    throw apiError(502, 'RDNS_UNREACHABLE', 'The DNS server did not answer', undefined, { detail: /^[A-Z][A-Z0-9_]{2,40}$/.test(code) ? code : 'no answer' });
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw apiError(502, 'RDNS_AUTH_FAILED', 'The DNS server refused the API key');
  if (!res.ok) throw apiError(502, 'RDNS_FAILED', 'The DNS server refused the change', undefined, { detail: `HTTP ${Math.floor(res.status / 100)}xx` });
  try { return text ? JSON.parse(text) : null; } catch { throw apiError(502, 'RDNS_FAILED', 'The DNS server refused the change', undefined, { detail: 'not JSON' }); }
}

// The longest zone that contains the reverse name (a /24 gives 2.0.192.in-addr.arpa., a /16 0.192...).
let zoneCache: { at: number; names: string[] } | null = null;
async function zoneFor(s: RdnsSettings, apiKey: string, rev: string, fresh = false) {
  if (fresh || !zoneCache || Date.now() - zoneCache.at > 60_000) {
    const zones = (await pdns(s, apiKey, '/zones')) as { name: string }[];
    zoneCache = { at: Date.now(), names: zones.map((z) => z.name) };
  }
  return zoneCache.names.filter((z) => rev === z || rev.endsWith(`.${z}`)).sort((a, b) => b.length - a.length)[0] ?? null;
}

// Writes (or with null removes) the PTR of one address.
export async function setPtr(ip: string, ptr: string | null, s?: RdnsSettings) {
  s ??= await getSettings('rdns');
  if (s.provider !== 'powerdns') throw apiError(409, 'RDNS_NOT_CONFIGURED', 'Reverse DNS is not set up');
  const apiKey = key(s);
  const rev = reverseName(ip);
  const zone = await zoneFor(s, apiKey, rev);
  if (!zone) throw apiError(409, 'RDNS_ZONE_NOT_FOUND', 'No reverse zone for this address on the DNS server', undefined, { reverseName: rev });
  const rrset = ptr ? { name: rev, type: 'PTR', ttl: s.ttl, changetype: 'REPLACE', records: [{ content: ptr, disabled: false }] } : { name: rev, type: 'PTR', changetype: 'DELETE' };
  await pdns(s, apiKey, `/zones/${encodeURIComponent(zone)}`, { method: 'PATCH', body: JSON.stringify({ rrsets: [rrset] }) });
}

// ---- queue: the worker asks for default records after a create and removal after a delete ----
export const rdnsQueue = new Queue('rdns', { connection: redis });
export function startRdnsWorker() {
  const connection = redis.duplicate({ maxRetriesPerRequest: null });
  const worker = new Worker('rdns', async (job) => {
    const s = await getSettings('rdns');
    if (s.provider === 'none') return;
    if (job.data.action === 'default' && s.template) {
      const { rows } = await pool.query(`SELECT host(a.address) AS address, s.name FROM ip_allocations a JOIN servers s ON s.id = a.server_id
        WHERE a.server_id = $1 AND a.ptr IS NULL`, [job.data.serverId]);
      for (const r of rows) {
        const ptr = renderPtr(s.template, r.address, r.name);
        await setPtr(r.address, ptr, s);
        await pool.query('UPDATE ip_allocations SET ptr = $2 WHERE address = $1::inet', [r.address, ptr]);
      }
    }
    if (job.data.action === 'clear') {
      for (const a of (job.data.addresses ?? []) as string[]) if (isIP(a)) await setPtr(a, null, s).catch((e) => { if (e.code !== 'RDNS_ZONE_NOT_FOUND') throw e; });
    }
  }, { connection, concurrency: 2 });
  worker.on('failed', (job, err) => logEvent('error', 'rdns_failed', { action: job?.data?.action, code: (err as { code?: string }).code ?? err.message }));
  worker.on('closed', () => connection.disconnect());
  return worker;
}

function readRdns(body: Input, saved: RdnsSettings) {
  const fields: Record<string, string> = {};
  const provider = body.provider === 'powerdns' ? 'powerdns' : body.provider === 'none' ? 'none' : (fields.provider = 'INVALID_VALUE', 'none');
  const apiUrl = typeof body.apiUrl === 'string' ? body.apiUrl.trim() : '';
  if (provider === 'powerdns' && !/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[\w./-]*)?$/i.test(apiUrl)) fields.apiUrl = 'INVALID_URL';
  const serverId = typeof body.serverId === 'string' && /^[\w.-]{1,64}$/.test(body.serverId) ? body.serverId : 'localhost';
  const template = typeof body.template === 'string' ? body.template.trim().toLowerCase() : '';
  if (template && !hostname.test(renderPtr(template, '192.0.2.10', 'web-1').replace(/\.$/, ''))) fields.template = 'INVALID_PTR_TEMPLATE';
  const ttl = Number(body.ttl ?? 3600);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) fields.ttl = 'OUT_OF_RANGE';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  // The stored key is for the server it was entered for: with another address in the form it is typed again
  // (otherwise the panel would send it to whatever host the form names).
  const base = (u: string) => u.replace(/\/+$/, '').toLowerCase();
  const kept = !apiUrl || base(apiUrl) === base(saved.apiUrl) ? saved.apiKeyEnc : null;
  if (provider === 'powerdns' && !apiKey && !kept) fields.apiKey = 'REQUIRED';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  const value: RdnsSettings = { provider, apiUrl, serverId, template, ttl, customerEdit: body.customerEdit !== false, forwardCheck: body.forwardCheck !== false,
    apiKeyEnc: apiKey ? encryptSecret(apiKey, 'settings:rdns') : kept };
  return { value, apiKey: apiKey || (kept ? decryptSecret(kept, 'settings:rdns') : '') };
}

@Controller('admin/settings/rdns') @UseGuards(PermissionGuard)
export class RdnsSettingsController {
  @Get() @Can('settings.view', 'settings.manage')
  async get() {
    const { apiKeyEnc, ...s } = await getSettings('rdns');
    return { ...s, apiKeySet: !!apiKeyEnc };
  }

  @Put() @Can('settings.manage')
  async save(@Req() req: AuthedRequest, @Body() body: Input) {
    const { value } = readRdns(body ?? {}, await getSettings('rdns'));
    await saveSettings('rdns', value);
    zoneCache = null;
    await audit(req, 'settings.rdns', 'success', req.user.id, { provider: value.provider, apiUrl: value.apiUrl });
    return this.get();
  }

  // Connects with the form's values and reports which IP pools have a reverse zone on the DNS server.
  @Post('test') @HttpCode(200) @Can('settings.manage')
  async test(@Req() req: AuthedRequest, @Body() body: Input) {
    const { value, apiKey } = readRdns({ ...body, provider: 'powerdns' }, await getSettings('rdns'));
    const server = await pdns(value, apiKey, '');
    zoneCache = null;
    const list = await pdns(value, apiKey, '/zones');
    const zones = (Array.isArray(list) ? list as { name?: unknown }[] : []).map((z) => String(z?.name ?? '')).filter((z) => z.length <= 255 && /(in-addr|ip6)\.arpa\.$/.test(z));
    const { rows } = await pool.query("SELECT name, host(range_start) AS first, host(network(ipv6_prefix)::inet + 16) AS v6 FROM ip_pools ORDER BY name");
    const covers = (ip: string | null) => !!ip && zones.some((z) => reverseName(ip).endsWith(`.${z}`) || reverseName(ip) === z);
    await audit(req, 'settings.rdns_test', 'success', req.user.id, { zones: zones.length });
    return { version: typeof server?.version === 'string' && /^[\w.+~-]{1,40}$/.test(server.version) ? server.version : '', zones, pools: rows.map((r) => ({ name: r.name, ipv4: covers(r.first), ipv6: r.v6 ? covers(r.v6) : null })) };
  }
}

// The addresses of a server and their PTRs; the owner (or staff) changes them here.
@Controller() @UseGuards(SessionGuard)
export class ServerIpsController {
  @Get('servers/:id/ips')
  async list(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await findServer(req, id);
    const s = await getSettings('rdns');
    const { rows } = await pool.query(`SELECT host(a.address) AS address, family(a.address) AS family, a.kind, a.ptr FROM ip_allocations a
      WHERE a.server_id = $1 ORDER BY a.kind = 'primary' DESC, family(a.address), a.address`, [id]);
    return { addresses: rows, rdns: { enabled: s.provider !== 'none', customerEdit: s.customerEdit, forwardCheck: s.forwardCheck } };
  }

  // Empty ptr goes back to the default (the admin's template), or removes the record when there is none.
  @Put('servers/:id/ips/:address/ptr')
  async setServerPtr(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('address') address: string, @Body() body: Input) {
    const server = await findServer(req, id, true);
    const s = await getSettings('rdns');
    if (s.provider === 'none') throw apiError(409, 'RDNS_NOT_CONFIGURED', 'Reverse DNS is not set up');
    const staff = req.user.permissions.includes('*') || req.user.permissions.includes('servers.manage_all');
    if (!s.customerEdit && !staff) throw apiError(403, 'RDNS_EDIT_DISABLED', 'Changing reverse DNS is not allowed here');
    const { rows: [a] } = await pool.query('SELECT host(address) AS address FROM ip_allocations WHERE server_id = $1 AND address = $2::inet', [id, address])
      .catch(() => ({ rows: [] }));
    if (!a) throw apiError(404, 'NOT_FOUND', 'Not an address of this server');
    const wanted = typeof body?.ptr === 'string' ? body.ptr.trim().toLowerCase().replace(/\.$/, '') : '';
    let ptr: string | null;
    if (!wanted) ptr = s.template ? renderPtr(s.template, a.address, server.name) : null;
    else {
      if (!hostname.test(wanted)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { ptr: 'INVALID_HOSTNAME_FQDN' });
      // The name must point back at the address (forward-confirmed reverse DNS), unless the admin turned this off.
      if (s.forwardCheck && !staff) {
        const resolved = await (isIP(a.address) === 4 ? dns.resolve4(wanted) : dns.resolve6(wanted)).catch(() => [] as string[]);
        if (!resolved.some((r) => r.toLowerCase() === a.address.toLowerCase())) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { ptr: 'PTR_FORWARD_MISMATCH' });
      }
      ptr = `${wanted}.`;
    }
    await setPtr(a.address, ptr, s);
    await pool.query('UPDATE ip_allocations SET ptr = $2 WHERE address = $1::inet', [a.address, ptr]);
    await audit(req, 'server.ptr', 'success', req.user.id, { serverId: id, address: a.address, ptr });
    return { address: a.address, ptr };
  }
}
