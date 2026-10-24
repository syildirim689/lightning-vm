// The panel's own address and certificate: what is served now, checks for a new name, validation of an
// uploaded certificate, and the change itself, which the host agent applies (scripts/install.sh domain).
import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { promises as dns } from 'node:dns';
import { connect } from 'node:tls';
import { checkCertificate } from './certificates';
import { apiError } from './errors';
import { audit, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { agentStatus, pendingRequests, queueRequest, settings as hostSettings } from './maintenance';

type Input = Record<string, unknown>;
const domainPattern = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// The certificate the proxy serves for a name, read over TLS inside the Compose network (not verified here:
// "trusted" says whether the system roots accept it).
function servedCertificate(name: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const socket = connect({ host: process.env.PROXY_HOST ?? 'proxy', port: 443, servername: name, rejectUnauthorized: false, timeout: 5000 }, () => {
      const c = socket.getPeerCertificate();
      const trusted = socket.authorized;
      socket.end();
      if (!c?.valid_to) return resolve(null);
      resolve({ subject: c.subject?.CN ?? '', issuer: c.issuer?.O ?? c.issuer?.CN ?? '', names: (c.subjectaltname ?? '').replace(/DNS:/g, '').split(', ').filter(Boolean),
        validFrom: new Date(c.valid_from).toISOString(), validTo: new Date(c.valid_to).toISOString(), daysLeft: Math.floor((Date.parse(c.valid_to) - Date.now()) / 86_400_000),
        fingerprint: c.fingerprint256, trusted, staging: /STAGING|\(STAGING\)/i.test(`${c.issuer?.O} ${c.issuer?.CN}`) });
    });
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
  });
}

async function addresses(name: string) {
  const [a, aaaa] = await Promise.all([dns.resolve4(name).catch(() => [] as string[]), dns.resolve6(name).catch(() => [] as string[])]);
  return { a: a.sort(), aaaa: aaaa.sort() };
}

@Controller('admin/domain') @UseGuards(PermissionGuard)
export class DomainController {
  @Get() @Can('system.view', 'settings.view')
  async current() {
    const s = hostSettings();
    const site = s.site && !s.site.startsWith(':') ? s.site : null;
    return { site, tlsMode: s.tlsMode || (site ? 'acme' : 'none'), agent: s.agent === 'on', certificate: site ? await servedCertificate(site) : null,
      dns: site ? await addresses(site) : null };
  }

  // A new name: where it points now, and whether that is where the current name points (the same server).
  @Post('check') @HttpCode(200) @Can('system.update')
  async check(@Body() body: Input) {
    const name = String(body?.domain ?? '').trim().toLowerCase();
    if (!domainPattern.test(name)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { domain: 'INVALID_DOMAIN' });
    const site = hostSettings().site;
    const [target, current] = await Promise.all([addresses(name), site && !site.startsWith(':') ? addresses(site) : null]);
    const same = !!current && target.a.length > 0 && target.a.every((a) => current.a.includes(a));
    return { domain: name, ...target, current: current ?? null, sameServer: current ? same : null };
  }

  @Post('certificate') @HttpCode(200) @Can('system.update')
  certificate(@Body() body: Input) {
    return checkCertificate(String(body?.cert ?? ''), String(body?.key ?? ''), String(body?.domain ?? '').trim().toLowerCase());
  }

  // Queues the change for the host agent; a failed change is rolled back there (the old address keeps working).
  @Post() @HttpCode(202) @Can('system.update')
  async change(@Req() req: AuthedRequest, @Body() body: Input) {
    const name = String(body?.domain ?? '').trim().toLowerCase();
    const tls = String(body?.tls ?? 'acme');
    if (!domainPattern.test(name)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { domain: 'INVALID_DOMAIN' });
    if (!['acme', 'staging', 'custom'].includes(tls)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { tls: 'INVALID_VALUE' });
    const files: Record<string, string> = {};
    let cert;
    if (tls === 'custom') {
      cert = checkCertificate(String(body?.cert ?? ''), String(body?.key ?? ''), name);
      files.cert = String(body.cert).replace(/\r\n/g, '\n').trim() + '\n';
      files.key = String(body.key).replace(/\r\n/g, '\n').trim() + '\n';
    }
    if (hostSettings().agent !== 'on' || pendingRequests() < 0) throw apiError(409, 'MAINTENANCE_AGENT_MISSING', 'The host agent is not installed (sudo sh scripts/install.sh agent on)');
    const status = agentStatus();
    const running = status?.state === 'running' && Date.now() - Date.parse(status.startedAt) < 3 * 3600_000;
    if (pendingRequests() > 0 || running) throw apiError(409, 'MAINTENANCE_BUSY', 'Another maintenance task is queued or running');
    const id = queueRequest({ action: 'domain', domain: name, tls, by: req.user.id }, files);
    await audit(req, 'system.domain_change', 'success', req.user.id, { id, domain: name, tls, ...(cert && { fingerprint: cert.fingerprint, validTo: cert.validTo }) });
    return { id };
  }
}
