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
import { claimRequest, csrfRejected, duplicateKey, releaseRequest } from './security';
import { AuthController } from './auth';
import { PublicController, SettingsController, SettingsOverviewController, SmsSettingsController } from './settings';
import { RolesController } from './rbac';
import { NotificationPolicyController, NotificationsController } from './notifications';
import { ChatController, ChatSettingsController } from './chat';
import { LiveController } from './live';
import { startSupportJanitor, SupportAdminController, SupportController } from './support';
import { StatsController } from './stats';
import { SignInMethodsController } from './sign-in-methods';
import { IncidentsController, startStatusSampler, StatusController, StatusPageSettingsController } from './status';
import { DirectorySettingsController } from './directory';
import { startNotificationWorker } from './notify';
import { startWebhookWorker } from './webhooks';
import { DeveloperController } from './developer';
import { ImportController } from './import';
import { DisputesAdminController, DisputesController } from './disputes';
import { CouponsAdminController } from './coupons';
import { TransfersAdminController, TransfersController } from './transfers';
import { ExternalController } from './external';
import { BackupsAdminController, BackupsController } from './backups';
import { ResellerController, ResellersAdminController } from './reseller';
import { PlacementController } from './placement';
import { DiskPriceController, DisksController } from './disks';
import { PrivateNetworksController, PrivateNetworkSettingsController } from './privnet';
import { ImagesController } from './images';
import { ensureRoles, watchRoles } from './permissions';
import { InsightsController, startInsightAlerts, StaffInsightsController } from './insights';
import { startHostLive } from './host-live';
import { startOsAlerts } from './os-alerts';
import { AdminServerUpdatesController, GuestUpdatesController, ServerUpdatesController } from './guest-updates';
import { OnboardingController, DigestController, AccountExportController, SmartController, TimeZoneController, MySessionsController } from './smart';
import { SchedulesController, startScheduler } from './schedules';
import { BillingAdminController, BillingCallbackController, BillingController, BillingSettingsController, startBilling } from './billing';
import { EinvoiceDocumentController, EinvoiceSettingsController, startEinvoice } from './einvoice';
import { ActivityController, AuditController } from './audit-log';
import { AnnouncementAdminController, AnnouncementController } from './announcement';
import { SnapshotsController } from './snapshots';
import { AlertsController } from './alerts';
import { TerminalController } from './terminal';
import { fromNodeHeaders } from 'better-auth/node';
import { getAuth, reloadAuth } from './better-auth';
import { SetupController } from './setup';
import { AdminController, UserSummaryController } from './admin';
import { UserSecurityController } from './user-security';
import { VmwareController } from './vmware';
import { ApiAdminController } from './api-access';
import { registerApiHooks, startApiLogJanitor } from './api-rate';
import { ApiDocsController, reference } from './api-reference';
import { startVmwareAutoScan, VmwareScanController } from './vmware-scan';
import { ConsoleController } from './console';
import { CatalogAdminController, CatalogController } from './catalog';
import { ServersAdminController, ServersController } from './servers';
import { FirewallsController } from './firewalls';
import { PaymentsController } from './payments';
import { ApplicationCallbackController, ApplicationsController } from './applications';
import { IsoAdminController, ServerIsoController } from './isos';
import { DomainController } from './domain';
import { LocationsController } from './locations';
import { TopologyAdminController, TopologyController } from './topology';
import { PowerController } from './power';
import { AbuseController } from './abuse';
import { VdcAdminController, VdcController } from './vdc';
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

// Every controller; the API reference (api-reference.ts) reads its routes from this list.
export const controllers = [HealthController, ApiAdminController, ApiDocsController, AuthController, PublicController, SetupController, AdminController, VmwareController, VmwareScanController, ConsoleController, CatalogAdminController, CatalogController, ServersController, ServersAdminController, FirewallsController, PaymentsController, RdnsSettingsController, ServerIpsController,
  SettingsController, SettingsOverviewController, SmsSettingsController, RolesController, NotificationsController, NotificationPolicyController,
  InsightsController, StaffInsightsController, ApplicationsController, ApplicationCallbackController, UserSecurityController, ServerUpdatesController, GuestUpdatesController, AdminServerUpdatesController, IsoAdminController, ServerIsoController, DomainController, LocationsController, TopologyAdminController, TopologyController, PowerController, AbuseController, VdcAdminController, VdcController, SmartController, OnboardingController, DigestController, AccountExportController, TimeZoneController, MySessionsController, SchedulesController, AuditController, ActivityController, AnnouncementController, AnnouncementAdminController, SnapshotsController, AlertsController, TerminalController, ChatController, ChatSettingsController, LiveController, DirectorySettingsController, StatusController, StatusPageSettingsController, UserSummaryController, IncidentsController, SupportController, SupportAdminController, StatsController, SignInMethodsController,
  BillingController, BillingCallbackController, BillingAdminController, BillingSettingsController, EinvoiceSettingsController, EinvoiceDocumentController, DeveloperController, ImportController, DisputesController, DisputesAdminController, ExternalController, BackupsController, BackupsAdminController, ResellerController, ResellersAdminController, PlacementController, DisksController, DiskPriceController, PrivateNetworksController, PrivateNetworkSettingsController, ImagesController, CouponsAdminController, TransfersController, TransfersAdminController];
reference.controllers = controllers;
@Module({ controllers })
class AppModule {}

// Only Caddy (and the web container behind it) on the Compose network talks to the API; its X-Forwarded-* headers are
// trusted. Caddy sends one client address, the one it worked out itself (deploy/caddy/Caddyfile), never the chain a
// client wrote: so trusting every private range here cannot be used to walk into a client-written entry.
const trustedProxies = process.env.TRUSTED_PROXIES?.split(',') ?? ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

// A body is parsed before any guard runs, so every route takes a small one (JSON forms; the largest carry a
// certificate chain or an install script). Only the routes that carry files take more, each what its own check
// allows: ticket and dispute attachments (3 files of 2 MB, base64), the logo and favicon (256 KB each).
const bodyLimit = 256 * 1024;
export const largeBodies: Record<string, number> = {
  'POST /support/tickets': 9 * 1024 * 1024, 'POST /support/tickets/:id/messages': 9 * 1024 * 1024, 'POST /billing/invoices/:id/disputes': 9 * 1024 * 1024,
  'PUT /admin/settings/branding': 1024 * 1024,
};

export async function createApp() {
  const adapter = new FastifyAdapter({ trustProxy: trustedProxies, logger: { base: { service: 'api', env: process.env.APP_ENV || 'production' }, formatters: { level: (level) => ({ level }) },
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] }, bodyLimit,
    // Open live streams (GET /live) must not hold a restart: closing ends every connection.
    forceCloseConnections: true });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  await app.register(fastifyCookie);
  // Before the controllers' routes are registered (app.init): the few that carry files get their own limit.
  app.getHttpAdapter().getInstance().addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      const limit = largeBodies[`${method} ${route.url}`];
      if (limit) route.bodyLimit = limit;
    }
  });
  registerApiHooks(app.getHttpAdapter().getInstance());
  app.getHttpAdapter().getInstance().addHook('onRequest', async (req, reply) => {
    if (csrfRejected(req)) return reply.status(403).send({ code: 'CSRF_REJECTED', message: 'Cross-site request rejected' });
  });
  app.getHttpAdapter().getInstance().addHook('preHandler', async (req, reply) => {
    const key = duplicateKey(req);
    if (!key) return;
    if (!(await claimRequest(key))) return reply.status(409).send({ code: 'DUPLICATE_REQUEST', message: 'The same request is already being processed' });
    (req as { dedupeKey?: string }).dedupeKey = key;
  });
  // Route templates (/servers/:id), not raw URLs, keep the label set bounded.
  app.getHttpAdapter().getInstance().addHook('onResponse', async (req, reply) => {
    const key = (req as { dedupeKey?: string }).dedupeKey;
    if (key) await releaseRequest(key);
    httpDuration.observe({ method: req.method, route: req.routeOptions.url ?? 'unmatched', status: `${Math.floor(reply.statusCode / 100)}xx` }, reply.elapsedTime / 1000);
  });
  // better-auth's routes (sign-in, sign-up, sign-out, sessions, password reset, passkeys). Caddy strips /api,
  // so the prefix is put back to match better-auth's basePath and the URLs it builds. The CSRF hook above
  // still runs first; static routes such as GET /auth/me take precedence over this wildcard. The instance
  // is built on the first request, after migrations (better-auth validates and caches the schema once).
  app.getHttpAdapter().getInstance().route({
    method: ['GET', 'POST'],
    url: '/auth/*',
    // Sign-in forms, mostly from people who are not signed in: nothing here is large.
    bodyLimit: 64 * 1024,
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
  await reloadAuth().catch(() => logEvent('error', 'sso_load_failed'));
  return app;
}

async function main() {
  const app = await createApp();
  app.enableShutdownHooks();
  startNotificationWorker();
  startWebhookWorker();
  startRdnsWorker();
  watchRoles();
  startInsightAlerts();
  startOsAlerts();
  startHostLive();
  startApiLogJanitor();
  startVmwareAutoScan();
  startScheduler();
  startBilling();
  startEinvoice();
  startStatusSampler();
  startSupportJanitor();
  await app.listen(4000, '0.0.0.0');
  process.on('SIGTERM', closeConnections); process.on('SIGINT', closeConnections);
}
if (require.main === module) main().catch(() => { logEvent('fatal', 'startup_failed'); process.exit(1); });
