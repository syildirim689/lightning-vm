// For people who automate: personal API tokens (auth.ts accepts them as "Authorization: Bearer lvm_…") and webhooks
// (webhooks.ts delivers them). Tokens are managed only from a signed-in browser, never with a token.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { publicUrl } from './chat-apps';
import { pool } from './db';
import { apiError } from './errors';
import { catalog, notify } from './notify';
import { customerLevel } from './permissions';
import { decryptSecret, encryptSecret } from './secrets';
import { validCidr } from './role-limits';
import { getSettings } from './settings-store';
import { post } from './webhooks';

type Input = Record<string, unknown>;
const maxTokens = 20;
const maxWebhooks = 10;
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const browserOnly = (req: AuthedRequest) => {
  if (req.sessionId?.startsWith('token:')) throw apiError(403, 'TOKEN_NOT_ALLOWED', 'Manage tokens and webhooks from the panel');
};
// A token or a webhook outlives the session that made it: staff acting as a customer would keep a way into the account
// (or a copy of its events).
const notActingAs = (req: AuthedRequest) => {
  if (req.user.impersonatedBy) throw apiError(403, 'NOT_WHILE_IMPERSONATING', 'Not while acting as another user');
};
const staff = (req: AuthedRequest) => req.user.permissions.some((p) => !customerLevel(p));
async function tokensOn(req: AuthedRequest) {
  const mode = (await getSettings('security')).apiTokens ?? 'everyone';
  if (mode === 'off' || (mode === 'staff' && !staff(req))) {
    throw apiError(403, 'API_TOKENS_DISABLED', 'The administrator turned API tokens off');
  }
}
// The events a person may subscribe to: those meant for customers, and for staff the staff ones (each is still
// delivered only when it reaches them, as their notifications do).
const eventsFor = (req: AuthedRequest) => Object.entries(catalog).filter(([, d]) => d.audience === 'user' || staff(req)).map(([k]) => k).sort();

@Controller('account') @UseGuards(SessionGuard)
export class DeveloperController {
  @Get('api-tokens')
  async tokens(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT id, name, hint, scope, permissions, allowed_ips AS "allowedIps", expires_at AS "expiresAt", last_used_at AS "lastUsedAt",
        host(last_used_ip) AS "lastUsedIp", created_at AS "createdAt" FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`, [req.user.id]);
    const api = await getSettings('api');
    // The rules the form has to follow: the longest life (0: none) and whether this person must set one.
    return { tokens: rows, max: maxTokens, rules: { maxDays: api.maxDays, expiryRequired: api.maxDays > 0 || (api.staffExpiry && staff(req)), rateLimit: api.rateLimit } };
  }

  // The token is returned once; only its hash is stored.
  @Post('api-tokens') @HttpCode(201)
  async createToken(@Req() req: AuthedRequest, @Body() body: Input) {
    browserOnly(req);
    notActingAs(req);
    await tokensOn(req);
    const fields: Record<string, string> = {};
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60) fields.name = 'REQUIRED';
    if (!['read', 'write'].includes(String(body?.scope))) fields.scope = 'INVALID_VALUE';
    const days = body?.expiresInDays === null || body?.expiresInDays === undefined ? null : Number(body.expiresInDays);
    const api = await getSettings('api');
    if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 3650)) fields.expiresInDays = 'INVALID_VALUE';
    else if (days === null && (api.maxDays > 0 || (api.staffExpiry && staff(req)))) fields.expiresInDays = 'EXPIRY_REQUIRED';
    else if (days !== null && api.maxDays > 0 && days > api.maxDays) fields.expiresInDays = 'EXPIRY_TOO_LONG';
    // Narrowed to some of the owner's permissions (none given: all of them).
    let permissions: string[] | null = null;
    if (Array.isArray(body?.permissions)) {
      permissions = [...new Set(body.permissions.map(String))];
      const own = req.user.permissions;
      if (!permissions.length || permissions.length > 100 || permissions.some((p) => !own.includes('*') && !own.includes(p))) fields.permissions = 'INVALID_VALUE';
    }
    const allowedIps = Array.isArray(body?.allowedIps) ? body.allowedIps.map((x) => String(x).trim()).filter(Boolean) : [];
    if (allowedIps.length > 20 || allowedIps.some((c) => !validCidr(c))) fields.allowedIps = 'INVALID_ADDRESS';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    if ((await pool.query('SELECT 1 FROM api_tokens WHERE user_id = $1', [req.user.id])).rowCount! >= maxTokens) throw apiError(409, 'LIMIT_REACHED', 'Too many tokens');
    const token = `lvm_${randomBytes(30).toString('base64url')}`;
    const { rows: [t] } = await pool.query(`INSERT INTO api_tokens (user_id, name, token_hash, hint, scope, expires_at, permissions, allowed_ips)
      VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7, $8)
      RETURNING id, name, hint, scope, permissions, allowed_ips AS "allowedIps", expires_at AS "expiresAt", created_at AS "createdAt"`,
      [req.user.id, name, tokenHash(token), token.slice(-4), body.scope, days, permissions, allowedIps]);
    await audit(req, 'account.api_token_created', 'success', req.user.id, { tokenId: t.id, scope: body.scope, permissions: permissions?.length ?? 'all', addresses: allowedIps.length });
    await notify('account.api_token_created', [req.user.id], { name, scope: String(body.scope) });
    return { ...t, token };
  }

  @Delete('api-tokens/:id') @HttpCode(204)
  async removeToken(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    browserOnly(req);
    const { rowCount } = await pool.query('DELETE FROM api_tokens WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown token');
    await audit(req, 'account.api_token_removed', 'success', req.user.id, { tokenId: id });
  }

  @Get('webhooks')
  async webhooks(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT w.id, w.url, w.description, w.events, w.active, w.failures, w.created_at AS "createdAt",
        (SELECT row_to_json(d) FROM (SELECT status, response_code AS "responseCode", created_at AS "at" FROM webhook_deliveries WHERE webhook_id = w.id ORDER BY created_at DESC LIMIT 1) d) AS "lastDelivery"
      FROM webhooks w WHERE w.user_id = $1 ORDER BY w.created_at`, [req.user.id]);
    return { webhooks: rows, events: eventsFor(req), max: maxWebhooks };
  }

  @Get('webhooks/:id/deliveries')
  async deliveries(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await owned(req, id);
    const { rows } = await pool.query(`SELECT id, event, status, attempts, response_code AS "responseCode", error, duration_ms AS "durationMs", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]);
    return { deliveries: rows };
  }

  // The signing secret is returned once (and again only by rotating it).
  @Post('webhooks') @HttpCode(201)
  async createWebhook(@Req() req: AuthedRequest, @Body() body: Input) {
    browserOnly(req);
    notActingAs(req);
    const v = await cleanWebhook(req, body);
    if ((await pool.query('SELECT 1 FROM webhooks WHERE user_id = $1', [req.user.id])).rowCount! >= maxWebhooks) throw apiError(409, 'LIMIT_REACHED', 'Too many webhooks');
    const id = randomUUID();
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    await pool.query('INSERT INTO webhooks (id, user_id, url, description, events, secret_enc) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, req.user.id, v.url, v.description, v.events, encryptSecret(secret, `webhook:${id}`)]);
    await audit(req, 'account.webhook_created', 'success', req.user.id, { webhookId: id });
    return { id, secret };
  }

  // Changing it switches it on again and forgets earlier failures.
  @Put('webhooks/:id')
  async updateWebhook(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    browserOnly(req);
    notActingAs(req);
    await owned(req, id);
    const v = await cleanWebhook(req, body);
    const active = body?.active === undefined ? true : body.active === true;
    await pool.query('UPDATE webhooks SET url = $2, description = $3, events = $4, active = $5, failures = 0 WHERE id = $1', [id, v.url, v.description, v.events, active]);
    await audit(req, 'account.webhook_updated', 'success', req.user.id, { webhookId: id });
    return { ok: true };
  }

  @Post('webhooks/:id/secret')
  async rotate(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    browserOnly(req);
    notActingAs(req);
    await owned(req, id);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    await pool.query('UPDATE webhooks SET secret_enc = $2 WHERE id = $1', [id, encryptSecret(secret, `webhook:${id}`)]);
    await audit(req, 'account.webhook_secret_rotated', 'success', req.user.id, { webhookId: id });
    return { secret };
  }

  // A "webhook.test" delivery now, answered with what the receiver said.
  @Post('webhooks/:id/test')
  async test(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const w = await owned(req, id);
    const deliveryId = randomUUID();
    const r = await post(w.url, decryptSecret(w.secret_enc, `webhook:${w.id}`), { id: deliveryId, event: 'webhook.test', createdAt: new Date().toISOString(), data: { message: 'Hello from Lightning VM' } } as never);
    await pool.query(`INSERT INTO webhook_deliveries (id, webhook_id, event, status, attempts, response_code, error, duration_ms) VALUES ($1, $2, 'webhook.test', $3, 1, $4, $5, $6)`,
      [deliveryId, id, r.ok ? 'succeeded' : 'failed', r.code, r.error, r.ms]);
    return { ok: r.ok, responseCode: r.code, error: r.error, durationMs: r.ms };
  }

  @Delete('webhooks/:id') @HttpCode(204)
  async removeWebhook(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    browserOnly(req);
    await owned(req, id);
    await pool.query('DELETE FROM webhooks WHERE id = $1', [id]);
    await audit(req, 'account.webhook_removed', 'success', req.user.id, { webhookId: id });
  }
}

async function owned(req: AuthedRequest, id: string) {
  const { rows: [w] } = await pool.query('SELECT * FROM webhooks WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  if (!w) throw apiError(404, 'NOT_FOUND', 'Unknown webhook');
  return w;
}

async function cleanWebhook(req: AuthedRequest, body: Input) {
  const fields: Record<string, string> = {};
  const raw = typeof body?.url === 'string' ? body.url.trim() : '';
  const url = raw && (await publicUrl(raw)) ? raw : (fields.url = 'WEBHOOK_URL_NOT_PUBLIC', '');
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 200) : '';
  const allowed = new Set(eventsFor(req));
  const events = Array.isArray(body?.events) ? [...new Set(body.events.map(String))] : [];
  if (!events.length || events.some((e) => e !== '*' && !allowed.has(e))) fields.events = 'INVALID_VALUE';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return { url, description, events };
}
