// Alertmanager -> panel: alerts from the monitoring stack become "admin.alert" notifications (in-app, e-mail, push,
// as the admin's notification policy and each person's choices say), so no receiver has to be configured on the
// server. Only containers on the internal network can call this: Caddy answers 404 for /api/internal/*, and a
// request that came through a proxy is refused here too.
// shortcut: trust is the internal Docker network, not a shared secret; add a token if untrusted containers ever
// join that network.
import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { apiError } from './errors';
import { logEvent } from './log';
import { notify } from './notify';
import { alertNotices } from './smart-rules';

@Controller('internal')
export class AlertsController {
  @Post('alerts') @HttpCode(204)
  async receive(@Req() req: FastifyRequest, @Body() body: unknown) {
    if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers.via) throw apiError(404, 'NOT_FOUND', 'Not found');
    const notices = alertNotices(body);
    for (const n of notices) await notify('admin.alert', 'staff:system.view', { ...n, resolved: n.resolved ? 'yes' : '' });
    logEvent('info', 'alerts_received', { count: notices.length });
  }
}
