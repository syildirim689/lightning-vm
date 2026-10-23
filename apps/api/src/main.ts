import 'reflect-metadata';
import { ArgumentsHost, Catch, Controller, ExceptionFilter, Get, HttpException, Module, Res, ServiceUnavailableException } from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { collectDefaultMetrics, register } from 'prom-client';
import type { FastifyReply } from 'fastify';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, max: 5 });
const redis = new Redis({ host: process.env.REDIS_HOST || 'redis', port: Number(process.env.REDIS_PORT) || 6379, password: process.env.REDIS_PASSWORD, maxRetriesPerRequest: 1, connectTimeout: 3000 });
redis.on('error', () => console.error(JSON.stringify({ level: 'error', service: 'api', event: 'redis_unavailable' })));
pool.on('error', () => console.error(JSON.stringify({ level: 'error', service: 'api', event: 'postgres_unavailable' })));
collectDefaultMetrics({ prefix: 'lightning_api_' });
@Controller()
class AppController {
  @Get('health') health() { return { status: 'alive' }; }
  @Get('ready') async ready() {
    try { await Promise.all([pool.query('SELECT 1'), redis.ping()]); return { status: 'ready' }; }
    catch { throw new ServiceUnavailableException({ code: 'DEPENDENCY_UNAVAILABLE', message: 'Dependencies unavailable' }); }
  }
  @Get('system') async system() {
    const rows = await pool.query("SELECT name, last_seen, last_seen > now() - interval '90 seconds' AS healthy FROM worker_heartbeats")
      .then(r => r.rows, () => { throw new ServiceUnavailableException({ code: 'DEPENDENCY_UNAVAILABLE', message: 'Dependencies unavailable' }); });
    return { stage: 'scaffold', worker: rows, capabilities: { authentication: false, vmware: false, console: false, provisioning: false } };
  }
  @Get('metrics') async metrics(@Res() reply: FastifyReply) {
    reply.type(register.contentType).send(await register.metrics());
  }
}
// Every error body is { code, message }: `code` is a stable English key the web UI translates.
@Catch()
class ErrorCodeFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (!(err instanceof HttpException)) {
      console.error(JSON.stringify({ level: 'error', service: 'api', event: 'unhandled_error', error: err instanceof Error ? err.name : 'unknown' }));
      return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Internal error' });
    }
    const body = err.getResponse();
    const status = err.getStatus();
    const code = typeof body === 'object' && 'code' in body ? String(body.code) : (STATUS_CODES[status] ?? 'UNKNOWN').toUpperCase().replace(/\W+/g, '_');
    reply.status(status).send({ code, message: err.message });
  }
}
@Module({ controllers: [AppController] })
class AppModule {}
export async function createApp() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie'] }, bodyLimit: 1048576 }));
  app.useGlobalFilters(new ErrorCodeFilter());
  return app;
}
let closing = false;
export async function closeConnections() { if (closing) return; closing = true; redis.disconnect(); await pool.end(); }
async function main() {
  const app = await createApp();
  app.enableShutdownHooks();
  await app.listen(4000, '0.0.0.0');
  process.on('SIGTERM', closeConnections); process.on('SIGINT', closeConnections);
}
if (require.main === module) main().catch(() => { console.error(JSON.stringify({ level: 'fatal', event: 'startup_failed' })); process.exit(1); });
