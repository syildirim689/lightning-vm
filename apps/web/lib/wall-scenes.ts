// The live walls there are, where each is opened from, and who may open it: exactly who may read the page it belongs
// to (the API asks the same permissions of every call the wall makes; this keeps the link and the page away from
// those it would only show refusals).
import { can, isStaff, type Permission } from './permissions';

export const wallScenes = ['system', 'stats', 'energy'] as const;
export type WallScene = typeof wallScenes[number];
export const isWallScene = (s: string): s is WallScene => (wallScenes as readonly string[]).includes(s);
// The API's permissions of what each wall reads: GET /admin/host/live (system.view); /admin/stats (dashboard.view);
// /admin/power (dashboard.view or system.view).
export const wallNeeds: Record<WallScene, Permission[]> = { system: ['system.view'], stats: ['dashboard.view'], energy: ['dashboard.view', 'system.view'] };
export const wallPage: Record<WallScene, string> = { system: '/admin/system', stats: '/admin/stats', energy: '/admin/energy' };
export const canWall = (perms: string[] | undefined, scene: WallScene) => isStaff(perms) && can(perms, ...wallNeeds[scene]);
export const wallsFor = (perms: string[] | undefined) => wallScenes.filter((s) => canWall(perms, s));
