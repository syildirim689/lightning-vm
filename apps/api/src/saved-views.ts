// Saved views of a list in the panel: a name for the filters and the order its address holds, kept with the account
// (not in the browser, where a search term or a customer's address typed by staff would outlive the session). Each
// person has their own, per list; one of a list's views may be the default the panel applies when the list is opened
// without filters. Only a list's own address parameters are stored, as text.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { SessionGuard, type AuthedRequest } from './auth';
import { foldText, pool } from './db';
import { apiError } from './errors';
import { rateLimit } from './security';

// The lists that have views and the address parameters of each (the same keys the panel passes to its SavedViews
// control: apps/web, the `list` and `keys` of each caller).
export const VIEW_LISTS: Record<string, readonly string[]> = {
  servers: ['q', 'state', 'tag', 'project', 'sort'],
  'admin-servers': ['q', 'state', 'tag', 'owner', 'sort', 'starred'],
  'admin-users': ['q', 'role', 'status'],
  'admin-audit': ['q', 'outcome', 'category'],
  'admin-invoices': ['status', 'q'],
  'admin-payments': ['status', 'q'],
  'admin-support': ['status', 'priority', 'department', 'assignee', 'q'],
};
export const VIEW_LIMIT = 12;
export const VIEW_NAME_MAX = 60;
export const VIEW_PARAMS_MAX = 12;
export const VIEW_VALUE_MAX = 200;

const isList = (v: unknown): v is string => typeof v === 'string' && Object.hasOwn(VIEW_LISTS, v);

// One spelling for a name: no line breaks, single spaces. Null when nothing is left or it is too long.
export function viewName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.replace(/\s+/g, ' ').trim();
  return name && name.length <= VIEW_NAME_MAX ? name : null;
}
// What two names are compared by: case and Turkish letters folded, as for other names.
export const viewNameKey = (name: string) => foldText(name);

// A list's parameters as { name: text }: its own names only, text values of a bounded length (an empty one is a
// choice of its own, e.g. "every status" where the list shows the active ones by default). Null when anything else.
export function viewParams(list: string, v: unknown): Record<string, string> | null {
  const allowed = isList(list) ? VIEW_LISTS[list] : null;
  if (!allowed || !v || typeof v !== 'object' || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > VIEW_PARAMS_MAX) return null;
  const out: Record<string, string> = {};
  for (const [k, value] of entries) {
    if (!allowed.includes(k) || typeof value !== 'string' || value.length > VIEW_VALUE_MAX) return null;
    out[k] = value;
  }
  return out;
}

export type ViewInput = { name?: string; params?: Record<string, string>; isDefault?: boolean };
// A new view (everything but isDefault required) or a change to one (`partial`: only what is sent, at least one).
export function viewInput(list: string, body: unknown, partial: boolean): ViewInput | { fields: Record<string, string> } {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const out: ViewInput = {};
  if (!isList(list)) fields.list = 'INVALID_VALUE';
  if (b.name !== undefined || !partial) {
    const name = viewName(b.name);
    if (name) out.name = name; else fields.name = typeof b.name === 'string' && b.name.trim() ? 'INVALID_VALUE' : 'REQUIRED';
  }
  if (b.params !== undefined || !partial) {
    const params = viewParams(list, b.params);
    if (params) out.params = params; else if (!fields.list) fields.params = b.params === undefined || b.params === null ? 'REQUIRED' : 'INVALID_VALUE';
  }
  if (b.isDefault !== undefined) {
    if (typeof b.isDefault === 'boolean') out.isDefault = b.isDefault; else fields.isDefault = 'INVALID_VALUE';
  }
  if (!Object.keys(fields).length && partial && !Object.keys(out).length) fields.name = 'REQUIRED';
  return Object.keys(fields).length ? { fields } : out;
}

const columns = 'id, name, params, is_default AS "isDefault"';
const invalid = (fields: Record<string, string>) => apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
const nameTaken = (err: unknown) => (err as { code?: string })?.code === '23505'
  ? apiError(409, 'VALIDATION_FAILED', 'Name taken', { name: 'NAME_TAKEN' }) : err;

// One change at a time per person and list: the count, the name and the single default are checked and written
// together, so two requests at once cannot both pass.
async function locked<T>(userId: string, list: string, run: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`saved-views:${userId}:${list}`]);
    const result = await run(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw nameTaken(err);
  } finally { db.release(); }
}

// Staff signed in as somebody see that person's views (the lists open as the person has them) but change nothing.
async function writer(req: AuthedRequest) {
  if (req.user.impersonatedBy) throw apiError(403, 'NOT_WHILE_IMPERSONATING', 'Not while acting as another user');
  await rateLimit(`saved-views:${req.user.id}`, 120, 600);
}

@Controller('saved-views') @UseGuards(SessionGuard)
export class SavedViewsController {
  @Get()
  async list(@Req() req: AuthedRequest, @Query('list') list?: string) {
    if (!isList(list)) throw invalid({ list: 'INVALID_VALUE' });
    const { rows } = await pool.query(`SELECT ${columns} FROM saved_views WHERE user_id = $1 AND list = $2 ORDER BY created_at, id`, [req.user.id, list]);
    return { views: rows };
  }

  @Post() @HttpCode(201)
  async add(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    await writer(req);
    const list = typeof body?.list === 'string' ? body.list : '';
    const v = viewInput(list, body, false);
    if ('fields' in v) throw invalid(v.fields);
    return locked(req.user.id, list, async (db) => {
      const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM saved_views WHERE user_id = $1 AND list = $2', [req.user.id, list]);
      if (n >= VIEW_LIMIT) throw apiError(409, 'LIMIT_REACHED', `At most ${VIEW_LIMIT} views per list`);
      if (v.isDefault) await db.query('UPDATE saved_views SET is_default = false WHERE user_id = $1 AND list = $2 AND is_default', [req.user.id, list]);
      const { rows: [row] } = await db.query(`INSERT INTO saved_views (user_id, list, name, name_key, params, is_default) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${columns}`,
        [req.user.id, list, v.name, viewNameKey(v.name!), JSON.stringify(v.params), v.isDefault === true]);
      return row;
    });
  }

  @Patch(':id')
  async change(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    await writer(req);
    const { rows: [own] } = await pool.query('SELECT list FROM saved_views WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!own) throw apiError(404, 'NOT_FOUND', 'Unknown view');
    const v = viewInput(own.list, body, true);
    if ('fields' in v) throw invalid(v.fields);
    return locked(req.user.id, own.list, async (db) => {
      if (v.isDefault) await db.query('UPDATE saved_views SET is_default = false WHERE user_id = $1 AND list = $2 AND is_default AND id <> $3', [req.user.id, own.list, id]);
      const { rows: [row] } = await db.query(`UPDATE saved_views SET name = coalesce($3, name), name_key = coalesce($4, name_key), params = coalesce($5::jsonb, params),
          is_default = coalesce($6, is_default), updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING ${columns}`,
        [id, req.user.id, v.name ?? null, v.name ? viewNameKey(v.name) : null, v.params ? JSON.stringify(v.params) : null, v.isDefault ?? null]);
      if (!row) throw apiError(404, 'NOT_FOUND', 'Unknown view');
      return row;
    });
  }

  @Delete(':id') @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await writer(req);
    const { rowCount } = await pool.query('DELETE FROM saved_views WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown view');
  }
}
