// A notice the admin shows on every signed-in page (planned maintenance, news), in Turkish and English, with an
// optional start and end time. Each saved version gets a new id, so a notice someone closed comes back when edited.
import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { pool } from './db';
import { randomUUID } from 'node:crypto';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { apiError } from './errors';
import { Can, PermissionGuard } from './rbac';
import { getSettings, saveSettings, type Announcement } from './settings-store';

export const live = (a: Announcement, now = Date.now()) => a.active && (!a.startsAt || Date.parse(a.startsAt) <= now) && (!a.endsAt || Date.parse(a.endsAt) > now);

@Controller() @UseGuards(SessionGuard)
export class AnnouncementController {
  @Get('announcement')
  async current() {
    const a = await getSettings('announcement');
    const { rows: [incident] } = await pool.query("SELECT id, title, impact, status FROM incidents WHERE resolved_at IS NULL ORDER BY (impact = 'major') DESC, created_at DESC LIMIT 1");
    return { announcement: live(a) ? { id: a.id, tone: a.tone, textTr: a.textTr, textEn: a.textEn, link: a.link, endsAt: a.endsAt } : null, incident: incident ?? null };
  }
}

@Controller('admin/settings') @UseGuards(PermissionGuard)
export class AnnouncementAdminController {
  @Get('announcement') @Can('settings.view', 'settings.manage')
  async get() { const a = await getSettings('announcement'); return { ...a, live: live(a) }; }

  @Put('announcement') @Can('settings.manage')
  async save(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const fields: Record<string, string> = {};
    const text = (k: string) => (typeof body?.[k] === 'string' ? (body[k] as string).trim() : '');
    const active = body?.active === true;
    const tone = ['info', 'warning', 'danger', 'success'].includes(String(body?.tone)) ? String(body.tone) as Announcement['tone'] : 'info';
    const textTr = text('textTr'), textEn = text('textEn'), link = text('link');
    if (textTr.length > 300) fields.textTr = 'TOO_LONG';
    if (textEn.length > 300) fields.textEn = 'TOO_LONG';
    if (active && !textTr && !textEn) fields.textTr = 'REQUIRED';
    // A path of this panel or an https address. "//host" and "/\host" look like paths and are other sites to a browser.
    if (link && !/^(https:\/\/[^\s]{1,300}|\/(?![\/\\])[^\s]{0,300})$/.test(link)) fields.link = 'INVALID_VALUE';
    const time = (k: string) => {
      const v = text(k);
      if (!v) return null;
      if (Number.isNaN(Date.parse(v))) { fields[k] = 'INVALID_VALUE'; return null; }
      return new Date(v).toISOString();
    };
    const startsAt = time('startsAt'), endsAt = time('endsAt');
    if (startsAt && endsAt && endsAt <= startsAt) fields.endsAt = 'END_BEFORE_START';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    const value: Announcement = { id: randomUUID(), active, tone, textTr, textEn, link, startsAt, endsAt };
    await saveSettings('announcement', value);
    await audit(req, 'settings.announcement', 'success', req.user.id, { active, tone, startsAt, endsAt });
    return { ...value, live: live(value) };
  }
}
