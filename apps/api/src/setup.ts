import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from './db';
import { apiError } from './errors';
import { audit, readCredentials, startSession } from './auth';
import { hashPassword, newToken, rateLimit, sha256 } from './security';

const bootstrapMinutes = 60;

// Called from the CLI on the server only: whoever can run it already controls the host.
export async function issueBootstrapToken() {
  const token = newToken();
  const { rowCount } = await pool.query(
    "UPDATE setup_state SET bootstrap_token_hash = $1, bootstrap_expires_at = now() + make_interval(mins => $2) WHERE admin_created_at IS NULL",
    [sha256(token), bootstrapMinutes]);
  return rowCount ? { token, expiresInMinutes: bootstrapMinutes } : null;
}

@Controller('setup')
export class SetupController {
  @Get('status')
  async status() {
    const { rows: [s] } = await pool.query('SELECT admin_created_at, completed_at FROM setup_state');
    return { adminCreated: !!s.admin_created_at, completed: !!s.completed_at };
  }

  @Post('admin') @HttpCode(201)
  async createAdmin(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() body: unknown) {
    await rateLimit(`setup:ip:${req.ip}`, 10, 900);
    const token = (body as { token?: unknown })?.token;
    const { email, password } = readCredentials(body);
    const locale = (body as { locale?: string }).locale === 'tr' ? 'tr' : 'en';
    const hash = await hashPassword(password); // slow; done before taking the row lock

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [s] } = await client.query('SELECT bootstrap_token_hash, bootstrap_expires_at > now() AS fresh, admin_created_at FROM setup_state FOR UPDATE');
      if (s.admin_created_at) throw apiError(409, 'SETUP_CLOSED', 'Setup admin already exists');
      if (typeof token !== 'string' || !s.bootstrap_token_hash || !s.fresh || !timingSafeEqual(sha256(token), s.bootstrap_token_hash)) {
        throw apiError(403, 'BOOTSTRAP_TOKEN_INVALID', 'Bootstrap token invalid or expired');
      }
      const { rows: [admin] } = await client.query(
        "INSERT INTO users (email, password_hash, role, locale) VALUES ($1, $2, 'admin', $3) RETURNING id, email, role, locale", [email, hash, locale]);
      await client.query('UPDATE setup_state SET admin_created_at = now(), bootstrap_token_hash = NULL, bootstrap_expires_at = NULL');
      await client.query('COMMIT');
      await startSession(req, reply, admin.id);
      await audit(req, 'setup.admin_created', 'success', admin.id);
      return admin;
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { getResponse?: () => { code?: string } }).getResponse?.().code === 'BOOTSTRAP_TOKEN_INVALID') await audit(req, 'setup.admin_created', 'denied', null);
      throw err;
    } finally {
      client.release();
    }
  }
}
