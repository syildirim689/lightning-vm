import 'reflect-metadata';
import { Controller, Get, Module, Res, ServiceUnavailableException } from '@nestjs/common';
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
    catch { throw new ServiceUnavailableException('Dependencies unavailable'); }
  }
  @Get('system') async system() {
    const rows = await pool.query("SELECT name, last_seen, last_seen > now() - interval '90 seconds' AS healthy FROM worker_heartbeats")
      .then(r => r.rows, () => { throw new ServiceUnavailableException('Dependencies unavailable'); });
    return { stage: 'scaffold', worker: rows, capabilities: { authentication: false, vmware: false, console: false, provisioning: false } };
  }
  @Get('metrics') async metrics(@Res() reply: FastifyReply) {
    reply.type(register.contentType).send(await register.metrics());
  }
}
@Module({ controllers: [AppController] })
class AppModule {}
export function createApp() {
  return NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie'] }, bodyLimit: 1048576 }));
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
