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
import { SetupController } from './setup';
import { AdminController } from './admin';

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

@Module({ controllers: [HealthController, AuthController, SetupController, AdminController] })
class AppModule {}

// Only Caddy on the Compose network talks to the API; its X-Forwarded-* headers are trusted.
const trustedProxies = process.env.TRUSTED_PROXIES?.split(',') ?? ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

export async function createApp() {
  const adapter = new FastifyAdapter({ trustProxy: trustedProxies, logger: { redact: ['req.headers.authorization', 'req.headers.cookie'] }, bodyLimit: 1048576 });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  await app.register(fastifyCookie);
  app.getHttpAdapter().getInstance().addHook('onRequest', async (req, reply) => {
    if (csrfRejected(req)) return reply.status(403).send({ code: 'CSRF_REJECTED', message: 'Cross-site request rejected' });
  });
  app.useGlobalFilters(new ErrorCodeFilter());
  return app;
}

async function main() {
  const app = await createApp();
  app.enableShutdownHooks();
  await app.listen(4000, '0.0.0.0');
  process.on('SIGTERM', closeConnections); process.on('SIGINT', closeConnections);
}
if (require.main === module) main().catch(() => { logEvent('fatal', 'startup_failed'); process.exit(1); });
