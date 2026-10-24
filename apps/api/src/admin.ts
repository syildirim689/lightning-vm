import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { pool } from './db';
import { apiError } from './errors';
import { audit, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { summary } from './maintenance';

@Controller('admin') @UseGuards(PermissionGuard)
export class AdminController {
  @Get('system') @Can('system.view', 'dashboard.view')
  async system() {
    const rows = await pool.query("SELECT name, last_seen, last_seen > now() - interval '90 seconds' AS healthy FROM worker_heartbeats")
      .then((r) => r.rows, () => { throw apiError(503, 'DEPENDENCY_UNAVAILABLE', 'Dependencies unavailable'); });
    return { worker: rows };
  }

  @Get('maintenance') @Can('system.view', 'dashboard.view')
  maintenance() { return summary(); }

  @Get('users') @Can('users.view', 'catalog.manage')
  async users() {
    const { rows } = await pool.query(`SELECT u.id, u.email, u.name, coalesce(u.role, 'user') AS role, u.locale, u.disabled_at, u.created_at AS "createdAt",
      coalesce(u.banned, false) AS banned, u.ban_reason AS "banReason", u.ban_expires AS "banExpires", u.two_factor_enabled AS "twoFactorEnabled",
      u.last_login_method AS "lastLoginMethod", u.phone_number AS "phoneNumber", u.phone_number_verified AS "phoneNumberVerified",
      (SELECT count(*)::int FROM servers s WHERE s.owner_id = u.id AND s.state <> 'deleted') AS servers,
      (SELECT count(*)::int FROM auth_sessions a WHERE a.user_id = u.id AND a.expires_at > now()) AS sessions,
      (SELECT max(a.created_at) FROM auth_sessions a WHERE a.user_id = u.id) AS "lastSeen",
      (SELECT count(*)::int FROM user_permission_overrides o WHERE o.user_id = u.id) AS overrides
      FROM users u ORDER BY u.created_at`);
    return { users: rows };
  }

  @Get('settings') @Can('settings.view', 'settings.manage')
  async settings() {
    const { rows: [s] } = await pool.query("SELECT value FROM settings WHERE key = 'registration_open'");
    return { registrationOpen: s?.value === true };
  }

  @Put('settings') @Can('settings.manage')
  async updateSettings(@Req() req: AuthedRequest, @Body() body: unknown) {
    const open = (body as { registrationOpen?: unknown })?.registrationOpen;
    if (typeof open !== 'boolean') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { registrationOpen: 'INVALID_VALUE' });
    await pool.query("UPDATE settings SET value = $1, updated_at = now() WHERE key = 'registration_open'", [JSON.stringify(open)]);
    await audit(req, 'settings.registration_open', 'success', req.user.id, { value: open });
    return { registrationOpen: open };
  }
}
