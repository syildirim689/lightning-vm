import 'reflect-metadata';
import { Controller, Get, Module, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { collectDefaultMetrics, register } from 'prom-client';
import type { FastifyReply } from 'fastify';
import { closeConnections, pool, redis } from './db';
import { apiError, ErrorCodeFilter } from './errors';
import { logEvent } from './log';
import { csrfRejected } from './security';
import { AuthController } from './auth';
import { PublicController, SettingsController, SmsSettingsController } from './settings';
import { RolesController } from './rbac';
import { NotificationPolicyController, NotificationsController } from './notifications';
import { startNotificationWorker } from './notify';
import { ensureRoles, watchRoles } from './permissions';
import { InsightsController, startInsightAlerts, StaffInsightsController } from './insights';
import { fromNodeHeaders } from 'better-auth/node';
import { getAuth } from './better-auth';
import { SetupController } from './setup';
import { AdminController } from './admin';
import { VmwareController } from './vmware';
import { ConsoleController } from './console';
import { CatalogAdminController, CatalogController } from './catalog';
import { ServersAdminController, ServersController } from './servers';
import { FirewallsController } from './firewalls';
import { PaymentsController } from './payments';
import { ApplicationCallbackController, ApplicationsController } from './applications';
import { IsoAdminController, ServerIsoController } from './isos';
import { DomainController } from './domain';
import { RdnsSettingsController, ServerIpsController, startRdnsWorker } from './rdns';
import { httpDuration } from './metrics';

export { closeConnections };
collectDefaultMetrics({ prefix: 'lightning_api_' });

@Controller()
class HealthController {
  @Get('health') health() { return { status: 'alive' }; }
  @Get('ready') async ready() {
    try { await Promise.all([pool.query('SELECT 1'), redis.ping()]); return { status: 'ready' }; }
    catch { throw apiError(503, 'DEPENDENCY_UNAVAILABLE', 'Dependencies unavailable'); }
  }
  @Get('metrics') async metrics(@Res() reply: FastifyReply) {
    reply.type(register.contentType).send(await register.metrics());
  }
}

@Module({ controllers: [HealthController, AuthController, PublicController, SetupController, AdminController, VmwareController, ConsoleController, CatalogAdminController, CatalogController, ServersController, ServersAdminController, FirewallsController, PaymentsController, RdnsSettingsController, ServerIpsController,
  SettingsController, SmsSettingsController, RolesController, NotificationsController, NotificationPolicyController,
  InsightsController, StaffInsightsController, ApplicationsController, ApplicationCallbackController, IsoAdminController, ServerIsoController, DomainController] })
class AppModule {}

// Only Caddy on the Compose network talks to the API; its X-Forwarded-* headers are trusted.
const trustedProxies = process.env.TRUSTED_PROXIES?.split(',') ?? ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

export async function createApp() {
  const adapter = new FastifyAdapter({ trustProxy: trustedProxies, logger: { base: { service: 'api', env: process.env.APP_ENV || 'production' }, formatters: { level: (level) => ({ level }) },
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] }, bodyLimit: 1048576 });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  await app.register(fastifyCookie);
  app.getHttpAdapter().getInstance().addHook('onRequest', async (req, reply) => {
    if (csrfRejected(req)) return reply.status(403).send({ code: 'CSRF_REJECTED', message: 'Cross-site request rejected' });
  });
  // Route templates (/servers/:id), not raw URLs, keep the label set bounded.
  app.getHttpAdapter().getInstance().addHook('onResponse', async (req, reply) => {
    httpDuration.observe({ method: req.method, route: req.routeOptions.url ?? 'unmatched', status: `${Math.floor(reply.statusCode / 100)}xx` }, reply.elapsedTime / 1000);
  });
  // better-auth's routes (sign-in, sign-up, sign-out, sessions, password reset, passkeys). Caddy strips /api,
  // so the prefix is put back to match better-auth's basePath and the URLs it builds. The CSRF hook above
  // still runs first; static routes such as GET /auth/me take precedence over this wildcard. The instance
  // is built on the first request, after migrations (better-auth validates and caches the schema once).
  app.getHttpAdapter().getInstance().route({
    method: ['GET', 'POST'],
    url: '/auth/*',
    async handler(req, reply) {
      const headers = fromNodeHeaders(req.headers);
      headers.set('x-lvm-client-ip', req.ip);
      const res = await getAuth().handler(new Request(new URL(`/api${req.url}`, `${req.protocol}://${req.host}`), {
        method: req.method, headers, body: req.method === 'GET' || req.body === undefined ? undefined : JSON.stringify(req.body),
      }));
      reply.status(res.status);
      res.headers.forEach((v, k) => { if (k !== 'set-cookie') reply.header(k, v); });
      const cookies = res.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(res.body ? await res.text() : null);
    },
  });
  app.useGlobalFilters(new ErrorCodeFilter());
  // better-auth asks synchronously whether a role exists; load them before the first request.
  await ensureRoles().catch(() => logEvent('error', 'roles_load_failed'));
  return app;
}

async function main() {
  const app = await createApp();
  app.enableShutdownHooks();
  startNotificationWorker();
  startRdnsWorker();
  watchRoles();
  startInsightAlerts();
  await app.listen(4000, '0.0.0.0');
  process.on('SIGTERM', closeConnections); process.on('SIGINT', closeConnections);
}
if (require.main === module) main().catch(() => { logEvent('fatal', 'startup_failed'); process.exit(1); });
