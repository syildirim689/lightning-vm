import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { pool } from './db';
import { apiError } from './errors';
import { AdminGuard, audit, type AuthedRequest } from './auth';
import { summary } from './maintenance';

@Controller('admin') @UseGuards(AdminGuard)
export class AdminController {
  @Get('system')
  async system() {
    const rows = await pool.query("SELECT name, last_seen, last_seen > now() - interval '90 seconds' AS healthy FROM worker_heartbeats")
      .then((r) => r.rows, () => { throw apiError(503, 'DEPENDENCY_UNAVAILABLE', 'Dependencies unavailable'); });
    return { worker: rows };
  }

  @Get('maintenance')
  maintenance() { return summary(); }

  @Get('users')
  async users() {
    const { rows } = await pool.query('SELECT id, email, role, locale, disabled_at, created_at FROM users ORDER BY created_at');
    return { users: rows };
  }

  @Get('settings')
  async settings() {
    const { rows: [s] } = await pool.query("SELECT value FROM settings WHERE key = 'registration_open'");
    return { registrationOpen: s?.value === true };
  }

  @Put('settings')
  async updateSettings(@Req() req: AuthedRequest, @Body() body: unknown) {
    const open = (body as { registrationOpen?: unknown })?.registrationOpen;
    if (typeof open !== 'boolean') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { registrationOpen: 'INVALID_VALUE' });
    await pool.query("UPDATE settings SET value = $1, updated_at = now() WHERE key = 'registration_open'", [JSON.stringify(open)]);
    await audit(req, 'settings.registration_open', 'success', req.user.id, { value: open });
    return { registrationOpen: open };
  }
}
