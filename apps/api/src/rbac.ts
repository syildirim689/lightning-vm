// Roles and permissions. A user holds one or more roles (users.role, comma-separated, as better-auth stores
// it); each role is a set of permissions; per-user overrides allow or deny single permissions on top.
// Every staff endpoint names the permission it needs (@Can); an endpoint without one is refused.
import { Body, CanActivate, Controller, Delete, ExecutionContext, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Put, Req, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { pool } from './db';
import { apiError } from './errors';
import { audit, PERMISSION, SessionGuard, type AuthedRequest } from './auth';
import { publishLive } from './live-bus';
import { ipAllowed, readLimits } from './role-limits';
import { can, covers, effectivePermissions, known, permissionCatalog, rolesChanged, permissionsOf, roles, splitRoles, type Permission } from './permissions';

// Throws unless the actor may act on the target account (its permissions are within the actor's).
export async function assertCovers(req: AuthedRequest, targetId: string) {
  if (targetId === req.user.id) return;
  const target = await permissionsOf(targetId);
  if (!covers(req.user.permissions, target)) throw apiError(403, 'FORBIDDEN_TARGET', 'This account has permissions you do not have');
}

export { PERMISSION };
// @Can('catalog.manage') on a handler: signed in and holding that permission (any of several, if given more). On a
// customer's route (SessionGuard) it is what a narrowed API token must hold to use the route; the person themselves is
// checked by the route (customerMay, ownership).
export const Can = (...perms: Permission[]) => SetMetadata(PERMISSION, perms);

@Injectable()
export class PermissionGuard extends SessionGuard implements CanActivate {
  constructor(private reflector: Reflector) { super(); }
  async canActivate(ctx: ExecutionContext) {
    await super.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const need = this.reflector.get<Permission[] | undefined>(PERMISSION, ctx.getHandler());
    // Deny by default: a staff endpoint someone forgot to annotate is closed, not open.
    if (need?.length && need.some((p) => can(req.user.permissions, p))) return true;
    await audit(req, 'admin.access', 'denied', req.user.id, { path: req.routeOptions.url, need: need ?? [] });
    throw apiError(403, 'FORBIDDEN', 'Permission required', undefined, { need: need ?? [] });
  }
}

type Input = Record<string, unknown>;
function readRole(body: Input, creating: boolean) {
  const fields: Record<string, string> = {};
  const key = String(body.key ?? '');
  if (creating && !/^[a-z][a-z0-9_-]{1,31}$/.test(key)) fields.key = 'INVALID_ROLE_KEY';
  const name = typeof body.name === 'string' && body.name.trim() && body.name.length <= 60 ? body.name.trim() : (fields.name = 'INVALID_VALUE', '');
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 300) : '';
  const perms = Array.isArray(body.permissions) ? body.permissions.map(String) : [];
  if (perms.some((p) => !known.has(p))) fields.permissions = 'INVALID_VALUE';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return { key, name, description, permissions: [...new Set(perms)].sort() };
}

// A role's limits from the form. Saving must not lock the saver out: their own role cannot exclude the address they use.
async function roleLimits(req: AuthedRequest, key: string, input: unknown) {
  const { rows } = await pool.query('SELECT id FROM locations');
  const ids = new Set(rows.map((r) => r.id as string));
  const { limits, fields } = readLimits(input, (id) => ids.has(id));
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  if (req.user.roles.includes(key) && !ipAllowed(limits.allowedIps, req.ip)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { 'limits.allowedIps': 'WOULD_LOCK_YOU_OUT' });
  return limits;
}

// A role that holds permissions the actor lacks is not theirs to rewrite or remove (roles.manage alone would otherwise
// let them strip or delete the roles above them). Read from the table, not from the cached roles.
async function mayChangeRole(req: AuthedRequest, key: string) {
  const { rows: [old] } = await pool.query('SELECT permissions FROM roles WHERE key = $1', [key]);
  if (old && !covers(req.user.permissions, old.permissions ?? [])) throw apiError(403, 'FORBIDDEN_TARGET', 'This role has permissions you do not have');
}

@Controller('admin') @UseGuards(PermissionGuard)
export class RolesController {
  @Get('permissions') @Can('users.view', 'roles.manage', 'users.roles')
  catalog() { return { groups: permissionCatalog }; }

  @Get('roles') @Can('users.view', 'roles.manage', 'users.roles')
  async list() {
    const { rows } = await pool.query(`SELECT r.key, r.name, r.description, r.permissions, r.builtin, r.limits,
      (SELECT count(*)::int FROM users u WHERE r.key = ANY(string_to_array(coalesce(u.role, 'user'), ','))) AS members FROM roles r ORDER BY r.builtin DESC, r.name`);
    return { roles: rows };
  }

  @Post('roles') @HttpCode(201) @Can('roles.manage')
  async create(@Req() req: AuthedRequest, @Body() body: Input) {
    const r = readRole(body ?? {}, true);
    if (!covers(req.user.permissions, r.permissions)) throw apiError(403, 'FORBIDDEN_TARGET', 'You cannot grant permissions you do not have');
    const limits = await roleLimits(req, r.key, body?.limits);
    await pool.query('INSERT INTO roles (key, name, description, permissions, limits) VALUES ($1, $2, $3, $4, $5)', [r.key, r.name, r.description, r.permissions, limits])
      .catch((e) => { if (e.code === '23505') throw apiError(409, 'VALIDATION_FAILED', 'Exists', { key: 'ROLE_EXISTS' }); throw e; });
    await rolesChanged();
    await publishLive(null, 'access');
    await audit(req, 'role.created', 'success', req.user.id, r);
    return r;
  }

  @Put('roles/:key') @Can('roles.manage')
  async update(@Req() req: AuthedRequest, @Param('key') key: string, @Body() body: Input) {
    if (key === 'admin') throw apiError(409, 'ROLE_LOCKED', 'The administrator role always has every permission');
    const r = readRole({ ...body, key }, false);
    if (!covers(req.user.permissions, r.permissions)) throw apiError(403, 'FORBIDDEN_TARGET', 'You cannot grant permissions you do not have');
    await mayChangeRole(req, key);
    const limits = await roleLimits(req, key, body?.limits);
    const { rowCount } = await pool.query('UPDATE roles SET name = $2, description = $3, permissions = $4, limits = $5, updated_at = now() WHERE key = $1', [key, r.name, r.description, r.permissions, limits]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown role');
    await rolesChanged();
    await publishLive(null, 'access');
    await audit(req, 'role.updated', 'success', req.user.id, { key, permissions: r.permissions, limits });
    return { ...r, key, limits };
  }

  // Members fall back to the remaining roles, or to "user" if this was their only one.
  @Delete('roles/:key') @HttpCode(204) @Can('roles.manage')
  async remove(@Req() req: AuthedRequest, @Param('key') key: string) {
    if (key === 'admin' || key === 'user') throw apiError(409, 'ROLE_LOCKED', 'Built-in base roles cannot be removed');
    await mayChangeRole(req, key);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query('DELETE FROM roles WHERE key = $1', [key]);
      if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown role');
      await client.query(`UPDATE users SET role = coalesce(nullif(array_to_string(array_remove(string_to_array(coalesce(role, 'user'), ','), $1), ','), ''), 'user'),
        updated_at = now() WHERE $1 = ANY(string_to_array(coalesce(role, 'user'), ','))`, [key]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await rolesChanged();
    await publishLive(null, 'access');
    await audit(req, 'role.deleted', 'success', req.user.id, { key });
  }

  @Get('users/:id/access') @Can('users.view', 'users.roles')
  async access(@Param('id', ParseUUIDPipe) id: string) {
    const { rows: [u] } = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
    if (!u) throw apiError(404, 'NOT_FOUND', 'Unknown user');
    const { rows: overrides } = await pool.query('SELECT permission, effect FROM user_permission_overrides WHERE user_id = $1 ORDER BY permission', [id]);
    return { roles: splitRoles(u.role), overrides, effective: effectivePermissions(u.role, overrides) };
  }

  // Roles and overrides are set together; the result must stay within the actor's own permissions.
  @Put('users/:id/access') @Can('users.roles')
  async setAccess(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const keys = Array.isArray(body?.roles) ? [...new Set(body.roles.map(String))] : [];
    const overrides = Array.isArray(body?.overrides) ? body.overrides as { permission?: unknown; effect?: unknown }[] : [];
    const fields: Record<string, string> = {};
    if (!keys.length || keys.some((k) => !roles.has(k))) fields.roles = 'INVALID_VALUE';
    if (overrides.some((o) => !known.has(String(o.permission)) || !['allow', 'deny'].includes(String(o.effect)))) fields.overrides = 'INVALID_VALUE';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    if (id === req.user.id) throw apiError(400, 'CANNOT_CHANGE_OWN_ACCOUNT', 'Not on your own account');
    await assertCovers(req, id);
    const clean = overrides.map((o) => ({ permission: String(o.permission), effect: String(o.effect) }));
    const roleValue = keys.join(',');
    const next = effectivePermissions(roleValue, clean);
    if (!covers(req.user.permissions, next)) throw apiError(403, 'FORBIDDEN_TARGET', 'You cannot grant permissions you do not have');
    if (next.includes('*') && clean.length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { overrides: 'NOT_FOR_ADMINS' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Never leave the panel without an administrator.
      if (!keys.includes('admin')) {
        const { rows: [n] } = await client.query(`SELECT count(*)::int AS n FROM users WHERE id <> $1 AND 'admin' = ANY(string_to_array(coalesce(role, ''), ',')) AND NOT coalesce(banned, false)`, [id]);
        if (n.n === 0) throw apiError(409, 'LAST_ADMIN', 'At least one administrator must remain');
      }
      await client.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [id, roleValue]);
      await client.query('DELETE FROM user_permission_overrides WHERE user_id = $1', [id]);
      for (const o of clean) await client.query('INSERT INTO user_permission_overrides (user_id, permission, effect) VALUES ($1, $2, $3)', [id, o.permission, o.effect]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await audit(req, 'user.access_changed', 'success', req.user.id, { target: id, roles: keys, overrides: clean });
    await publishLive(id, 'access');
    return { roles: keys, overrides: clean, effective: next };
  }
}

