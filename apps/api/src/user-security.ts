// Staff: how one person signs in (verified e-mail and phone, two-factor, passkeys, linked accounts, recent
// sign-in activity) and the fixes support is asked for: mark the e-mail verified, reset or unlock two-factor,
// remove a passkey, unlink an outside account. Sessions themselves are in admin.ts.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { audit, type AuthedRequest } from './auth';
import { pool } from './db';
import { apiError } from './errors';
import { closeConsoles } from './better-auth';
import { publishLive } from './live-bus';
import { dropPush } from './notify';
import { assertCovers, Can, PermissionGuard } from './rbac';

const none = () => ({ rows: [] as Record<string, unknown>[] });

@Controller('admin/users/:id') @UseGuards(PermissionGuard)
export class UserSecurityController {
  @Get('security') @Can('users.view')
  async security(@Param('id', ParseUUIDPipe) id: string) {
    const { rows: [u] } = await pool.query(`SELECT email, email_verified AS "emailVerified", username, phone_number AS "phoneNumber", coalesce(phone_number_verified, false) AS "phoneVerified",
      coalesce(two_factor_enabled, false) AS "twoFactorEnabled", last_login_method AS "lastLoginMethod", auth_source AS "authSource", locale, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM users WHERE id = $1`, [id]);
    if (!u) throw apiError(404, 'NOT_FOUND', 'Unknown user');
    const [passkeys, accounts, twoFactor, signIns, sessions] = await Promise.all([
      pool.query('SELECT id, name, device_type AS "deviceType", backed_up AS "backedUp", created_at AS "createdAt" FROM auth_passkeys WHERE user_id = $1 ORDER BY created_at', [id]).catch(none),
      pool.query('SELECT provider_id AS provider, created_at AS "createdAt", updated_at AS "updatedAt", password IS NOT NULL AS "hasPassword" FROM auth_accounts WHERE user_id = $1 ORDER BY created_at', [id]).catch(none),
      pool.query('SELECT coalesce(failed_verification_count, 0) AS failed, locked_until AS "lockedUntil" FROM auth_two_factors WHERE user_id = $1 LIMIT 1', [id]).catch(none),
      pool.query(`SELECT action, outcome, created_at AS at, host(ip) AS ip FROM audit_events WHERE actor_id = $1 AND action LIKE 'auth.%' ORDER BY created_at DESC LIMIT 12`, [id]).catch(none),
      pool.query(`SELECT count(*) FILTER (WHERE expires_at > now())::int AS active, count(*) FILTER (WHERE expires_at > now() AND impersonated_by IS NOT NULL)::int AS impersonated,
        min(created_at) FILTER (WHERE expires_at > now()) AS oldest FROM auth_sessions WHERE user_id = $1`, [id]).catch(none),
    ]);
    const password = accounts.rows.find((a) => a.provider === 'credential');
    return { ...u, password: password ? { set: !!password.hasPassword, changedAt: password.updatedAt } : { set: false, changedAt: null },
      accounts: accounts.rows.filter((a) => a.provider !== 'credential').map(({ hasPassword: _p, ...a }) => a), passkeys: passkeys.rows,
      twoFactor: twoFactor.rows[0] ?? null, signIns: signIns.rows, sessions: sessions.rows[0] ?? { active: 0, impersonated: 0, oldest: null } };
  }

  // Support confirmed the address another way (or wants it confirmed again at the next sign-in).
  @Put('email-verified') @Can('users.manage')
  async emailVerified(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    await assertCovers(req, id);
    if (typeof body?.verified !== 'boolean') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { verified: 'INVALID_VALUE' });
    const { rowCount } = await pool.query('UPDATE users SET email_verified = $2, updated_at = now() WHERE id = $1', [id, body.verified]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown user');
    await audit(req, 'admin.user.email_verified', 'success', req.user.id, { target: id, verified: body.verified });
    return { emailVerified: body.verified };
  }

  // The person lost their phone: two-factor goes off (they turn it on again themselves). Other sessions end, so
  // whoever holds an old one must sign in again with the password.
  @Delete('two-factor') @HttpCode(204) @Can('users.manage')
  async resetTwoFactor(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await assertCovers(req, id);
    if (id === req.user.id) throw apiError(400, 'CANNOT_CHANGE_OWN_ACCOUNT', 'Not on your own account');
    // The sessions go below without better-auth (so without its hook): what they had open is closed here, while
    // their tokens can still be read, and the browsers they were in stop receiving the account's notifications.
    await closeConsoles(id);
    await dropPush(id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query('UPDATE users SET two_factor_enabled = false, updated_at = now() WHERE id = $1', [id]);
      if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown user');
      await client.query('DELETE FROM auth_two_factors WHERE user_id = $1', [id]);
      await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await audit(req, 'admin.user.two_factor_reset', 'success', req.user.id, { target: id });
    await publishLive(id, 'sessions');
  }

  // Too many wrong codes locked the second step: let them try again now.
  @Post('two-factor/unlock') @HttpCode(204) @Can('users.manage')
  async unlockTwoFactor(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await assertCovers(req, id);
    await pool.query('UPDATE auth_two_factors SET failed_verification_count = 0, locked_until = NULL WHERE user_id = $1', [id]);
    await audit(req, 'admin.user.two_factor_unlock', 'success', req.user.id, { target: id });
  }

  @Delete('passkeys/:pid') @HttpCode(204) @Can('users.manage')
  async removePasskey(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('pid') pid: string) {
    await assertCovers(req, id);
    const { rowCount } = /^[\w-]{1,64}$/.test(pid) ? await pool.query('DELETE FROM auth_passkeys WHERE id = $2 AND user_id = $1', [id, pid]) : { rowCount: 0 };
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown passkey');
    await audit(req, 'admin.user.passkey_removed', 'success', req.user.id, { target: id });
  }

  // Unlinks an outside account (Google, GitHub, SSO...). Never the last way in: a password or another account must remain.
  @Delete('accounts/:provider') @HttpCode(204) @Can('users.manage')
  async unlink(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('provider') provider: string) {
    await assertCovers(req, id);
    if (!/^[\w.-]{1,64}$/.test(provider) || provider === 'credential') throw apiError(404, 'NOT_FOUND', 'Unknown account');
    const { rows } = await pool.query('SELECT provider_id AS provider, password IS NOT NULL AS "hasPassword" FROM auth_accounts WHERE user_id = $1', [id]);
    if (!rows.some((a) => a.provider === provider)) throw apiError(404, 'NOT_FOUND', 'Unknown account');
    if (!rows.some((a) => a.provider !== provider && (a.provider !== 'credential' || a.hasPassword))) throw apiError(409, 'LAST_SIGN_IN_METHOD', 'This is the only way this person can sign in');
    await pool.query('DELETE FROM auth_accounts WHERE user_id = $1 AND provider_id = $2', [id, provider]);
    await audit(req, 'admin.user.account_unlinked', 'success', req.user.id, { target: id, provider });
  }
}
