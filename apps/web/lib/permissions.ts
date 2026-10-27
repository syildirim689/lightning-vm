// Mirrors the API's permission names (apps/api/src/permissions.ts). The API enforces them; the panel only
// uses them to show what the user can actually open.
export type Permission = 'dashboard.view' | 'servers.create' | 'firewalls.manage' | 'servers.view_all' | 'servers.manage_all' | 'operations.retry' | 'reconcile.run' | 'consoles.any'
  | 'catalog.view' | 'catalog.manage' | 'vmware.view' | 'vmware.manage' | 'users.view' | 'users.manage' | 'users.roles' | 'users.ban' | 'users.sessions'
  | 'users.impersonate' | 'roles.manage' | 'settings.view' | 'settings.manage' | 'system.view' | 'system.update' | 'audit.view' | 'system.terminal'
  | 'server.power' | 'server.console' | 'server.delete' | 'server.snapshots' | 'server.iso' | 'server.root_password' | 'server.resize' | 'server.reinstall' | 'server.backups' | 'support.view' | 'support.manage' | 'billing.view' | 'billing.manage';

export const can = (perms: string[] | undefined, ...need: Permission[]) => !!perms && (perms.includes('*') || need.some((p) => perms.includes(p)));
// Anyone with a permission beyond what customers have for their own servers sees the staff area.
const customer = new Set(['servers.create', 'firewalls.manage', 'server.power', 'server.console', 'server.delete', 'server.snapshots', 'server.iso', 'server.root_password', 'server.resize', 'server.reinstall', 'server.backups']);
export const isStaff = (perms: string[] | undefined) => !!perms && perms.some((p) => !customer.has(p));
