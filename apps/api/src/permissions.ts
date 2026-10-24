// Roles and permissions, without HTTP: the catalog, the role cache and effective permissions.
// Shared by the guards (rbac.ts), the session (auth.ts) and better-auth's hooks.
import { pool, redis } from './db';

// The catalog: group → permissions. The web panel shows these with translated names and explanations.
export const permissionCatalog = {
  dashboard: ['dashboard.view'],
  servers: ['servers.create', 'firewalls.manage', 'servers.view_all', 'servers.manage_all', 'operations.retry', 'reconcile.run', 'consoles.any'],
  catalog: ['catalog.view', 'catalog.manage'],
  vmware: ['vmware.view', 'vmware.manage'],
  users: ['users.view', 'users.manage', 'users.roles', 'users.ban', 'users.sessions', 'users.impersonate'],
  roles: ['roles.manage'],
  settings: ['settings.view', 'settings.manage'],
  system: ['system.view', 'system.update', 'audit.view'],
} as const;
export type Permission = (typeof permissionCatalog)[keyof typeof permissionCatalog][number];
export const allPermissions = Object.values(permissionCatalog).flat() as Permission[];
export const known = new Set<string>(allPermissions);

export type Role = { key: string; name: string; description: string; permissions: string[]; builtin: boolean };
export let roles = new Map<string, Role>();
// Loaded at start and after every change; better-auth asks synchronously whether a role exists.
export async function loadRoles() {
  const { rows } = await pool.query('SELECT key, name, description, permissions, builtin FROM roles ORDER BY builtin DESC, name');
  roles = new Map(rows.map((r) => [r.key, r]));
  return [...roles.values()];
}
// Before the first request (and again if the database was down at start).
export async function ensureRoles() { if (!roles.size) await loadRoles(); }
export const roleExists = (key: string) => roles.has(key);
export const splitRoles = (value: string | null | undefined) => (value || 'user').split(',').map((r) => r.trim()).filter(Boolean);

export function effectivePermissions(roleValue: string | null | undefined, overrides: { permission: string; effect: string }[]): string[] {
  const keys = splitRoles(roleValue);
  const set = new Set<string>(keys.flatMap((k) => roles.get(k)?.permissions ?? []));
  if (set.has('*')) return ['*']; // superusers cannot be narrowed (overrides on them are refused when written)
  for (const o of overrides) if (o.effect === 'allow') set.add(o.permission); else set.delete(o.permission);
  return [...set].filter((p) => known.has(p)).sort();
}
export const can = (perms: string[], p: Permission) => perms.includes('*') || perms.includes(p);
// "a may grant/act on b": everything b has, a has too. Stops a support user from promoting themselves or acting on admins.
export const covers = (a: string[], b: string[]) => a.includes('*') || (!b.includes('*') && b.every((p) => a.includes(p)));

export async function permissionsOf(userId: string, roleValue?: string | null) {
  await ensureRoles();
  const [{ rows: overrides }, role] = await Promise.all([
    pool.query('SELECT permission, effect FROM user_permission_overrides WHERE user_id = $1', [userId]),
    roleValue === undefined ? pool.query('SELECT role FROM users WHERE id = $1', [userId]).then((r) => r.rows[0]?.role as string | undefined) : Promise.resolve(roleValue),
  ]);
  return effectivePermissions(role, overrides);
}

// better-auth's admin plugin checks roles by name; it gets every role from the table, each allowed through,
// because the real check (permission, and the target being within the actor's reach) runs in our hook.
export const betterAuthRoles = new Proxy({} as Record<string, { authorize: () => { success: true }; statements: object }>, {
  get: (_t, key) => (typeof key === 'string' && roles.has(key) ? { authorize: () => ({ success: true as const }), statements: {} } : undefined),
  has: (_t, key) => typeof key === 'string' && roles.has(key),
});

// better-auth admin endpoints → the permission each needs. Anything under /admin/ not listed is refused.
export const adminEndpointPermission: Record<string, Permission | null> = {
  '/admin/list-users': 'users.view', '/admin/get-user': 'users.view', '/admin/list-user-sessions': 'users.view',
  '/admin/create-user': 'users.manage', '/admin/update-user': 'users.manage', '/admin/set-user-password': 'users.manage', '/admin/remove-user': 'users.manage',
  '/admin/ban-user': 'users.ban', '/admin/unban-user': 'users.ban',
  '/admin/revoke-user-session': 'users.sessions', '/admin/revoke-user-sessions': 'users.sessions',
  '/admin/impersonate-user': 'users.impersonate',
  '/admin/stop-impersonating': null, // called by the impersonated session itself
  '/admin/has-permission': null,
};

// Several API copies each keep the roles in memory: a change made on one copy is announced on Redis so every
// copy reloads at once (a removed permission must stop working everywhere), with a periodic reload as a backstop.
const rolesChannel = `lvm:roles-changed:${Number(process.env.REDIS_DB) || 0}`;
export async function rolesChanged() {
  await loadRoles();
  await redis.publish(rolesChannel, '1').catch(() => undefined);
}
export function watchRoles() {
  const sub = redis.duplicate();
  sub.subscribe(rolesChannel).catch(() => undefined);
  sub.on('message', () => { loadRoles().catch(() => undefined); });
  const timer = setInterval(() => { loadRoles().catch(() => undefined); }, 60_000).unref();
  return { close: () => { clearInterval(timer); sub.disconnect(); } };
}
