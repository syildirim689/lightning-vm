// Mirrors the API's permission names (apps/api/src/permissions.ts). The API enforces them; the panel only
// uses them to show what the user can actually open.
export type Permission = 'dashboard.view' | 'servers.create' | 'servers.view_all' | 'servers.manage_all' | 'operations.retry' | 'reconcile.run' | 'consoles.any'
  | 'catalog.view' | 'catalog.manage' | 'vmware.view' | 'vmware.manage' | 'users.view' | 'users.manage' | 'users.roles' | 'users.ban' | 'users.sessions'
  | 'users.impersonate' | 'roles.manage' | 'settings.view' | 'settings.manage' | 'system.view' | 'audit.view';

export const can = (perms: string[] | undefined, ...need: Permission[]) => !!perms && (perms.includes('*') || need.some((p) => perms.includes(p)));
// Anyone with a permission beyond ordering servers sees the staff area.
export const isStaff = (perms: string[] | undefined) => !!perms && perms.some((p) => p !== 'servers.create');
