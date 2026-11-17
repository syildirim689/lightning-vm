// Handing a server to another account (migration 054). The owner offers it by e-mail; the other account accepts (or
// declines) within a week, and only then does the server, with its subscription, move. Staff may move one at once.
// A server moves only when nothing of the old owner stays attached to it: no firewall or private network of theirs,
// no unpaid invoice, no task running, no copy of it on order. Snapshots, backups and extra disks are the server's and go
// with it; what let the old owner into it or act on it (stored keys and password, guest tokens, schedules, an open
// console) ends with the move (moveServer).
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { exceededQuota } from './capacity';
import { limitsFor, usageOf } from './catalog';
import { revokeConsoles } from './console';
import { pool } from './db';
import { apiError } from './errors';
import { notify } from './notify';
import { Can, PermissionGuard } from './rbac';

type Db = typeof pool | PoolClient;
type Server = { id: string; owner_id: string; name: string; vcpu: number; memory_mb: number; disk_gb: number };
const blocked = (reason: string) => apiError(409, 'TRANSFER_NOT_POSSIBLE', 'This server cannot be handed over now', { server: reason });

// Why the server cannot go from its owner to `toId` now (throws), or nothing.
async function checkTransfer(db: Db, serverId: string, toId: string) {
  const { rows: [s] } = await db.query(`SELECT s.*, o.reseller_id AS from_reseller, EXISTS (SELECT 1 FROM resellers r WHERE r.user_id = s.owner_id) AS from_is_reseller,
      EXISTS (SELECT 1 FROM firewall_servers f WHERE f.server_id = s.id) AS has_firewalls,
      EXISTS (SELECT 1 FROM private_network_members m WHERE m.server_id = s.id) AS has_networks,
      EXISTS (SELECT 1 FROM operations p WHERE p.server_id = s.id AND p.status IN ('pending', 'running')) AS busy,
      EXISTS (SELECT 1 FROM servers c WHERE c.clone_from_server_id = s.id AND c.vm_moref IS NULL AND c.state = 'provisioning') AS copy_pending,
      EXISTS (SELECT 1 FROM isos i WHERE i.id = s.iso_id AND NOT i.public) AS private_iso,
      EXISTS (SELECT 1 FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id JOIN subscriptions b ON b.id = l.subscription_id WHERE b.server_id = s.id AND i.status = 'unpaid') AS unpaid
    FROM servers s JOIN users o ON o.id = s.owner_id WHERE s.id = $1`, [serverId]);
  if (!s) throw apiError(404, 'NOT_FOUND', 'Unknown server');
  const { rows: [to] } = await db.query('SELECT id, reseller_id, EXISTS (SELECT 1 FROM resellers r WHERE r.user_id = u.id) AS is_reseller FROM users u WHERE id = $1', [toId]);
  if (!to) throw apiError(404, 'NOT_FOUND', 'Unknown account');
  if (to.id === s.owner_id) throw blocked('SAME_OWNER');
  if (s.state !== 'ready' || s.busy) throw blocked('SERVER_BUSY');
  if (s.vdc_id) throw blocked('IN_DATA_CENTER');
  if (s.billing_mode !== 'monthly' || s.external_source) throw blocked('BILLED_ELSEWHERE');
  if (s.from_reseller || s.from_is_reseller || to.reseller_id || to.is_reseller) throw blocked('RESELLER_ACCOUNT');
  if (s.billing_hold || s.unpaid) throw blocked('UNPAID_INVOICE');
  if (s.has_firewalls) throw blocked('HAS_FIREWALLS');
  if (s.has_networks) throw blocked('HAS_PRIVATE_NETWORKS');
  // A copy ordered from it and not built yet would be built from the new owner's disk (the worker refuses that too).
  if (s.copy_pending) throw blocked('CLONE_PENDING');
  // An ISO staff inserted for the old owner only (not in the public library) is ejected first; the new owner could not insert it.
  if (s.private_iso) throw blocked('PRIVATE_ISO_MOUNTED');
  if ((await db.query("SELECT 1 FROM servers WHERE owner_id = $1 AND name = $2 AND state <> 'deleted'", [toId, s.name])).rowCount) throw blocked('NAME_TAKEN');
  const over = exceededQuota(await limitsFor(toId, undefined, db), await usageOf(toId, undefined, db), { vcpu: s.vcpu, memoryMb: s.memory_mb, diskGb: s.disk_gb });
  if (over.length) throw blocked('RECIPIENT_QUOTA');
  return s as Server;
}

// The move itself, in the caller's transaction: the server and its running subscription change hands, and nothing the
// previous owner chose or was given stays usable on it. Everything keyed to the server, and what happens to it:
//   servers.ssh_public_keys, root_password_hash, root_password_enc: cleared. They are the previous owner's way into the
//     guest, and a reinstall would write them onto the new owner's fresh disk; the stored password would also be readable
//     by the new owner. The disk as it is still has them (the new owner reinstalls or changes them inside); the next
//     reinstall takes the new owner's keys or, without any, makes a new password (servers.ts).
//   server_updates (update reporter token, policy, last report): deleted. The token was in the previous owner's install
//     command; the reporter removes itself on its next run, and the new owner turns tracking on for a token of their own.
//   servers.app_token_hash, app_script_enc (application callback token, the install script with its licence key): cleared;
//     the application and its licence stay with the server.
//   power_schedules: deleted (the previous owner's start, stop, snapshot and backup times).
//   servers.tags, notes, project_id: cleared (the previous owner's own labels); delete_at: cleared (a deletion they
//     scheduled must not run on the new owner's server). locked stays (it only protects).
//   server_favorites: the previous owner's star removed; staff's stay.
//   backups: owner_id follows the server (they are its disk, and are deleted with it).
//   os_images made from this server: stay the previous owner's (their copy of what was theirs then); only the link back
//     to the server is dropped. A server running from such an image keeps running; its new owner reinstalls from another.
//   tickets of the previous owner about this server: keep their text, lose the link.
//   subscriptions: the running one follows; invoices, coupon redemptions and finished operations stay as records.
//   server_disks, ip_allocations (with PTR), application_licenses, traffic, usage and power samples, abuse and
//     reconciliation findings, snapshots: the server's own, unchanged.
//   firewall_servers, private_network_members, a VDC, a copy on order, a staff-only ISO in the drive: checkTransfer refuses.
// The previous owner's open consoles are closed by the callers once the move is committed (ownerLeft).
async function moveServer(db: PoolClient, s: Server, toId: string) {
  await db.query(`UPDATE servers SET owner_id = $2, project_id = NULL, ssh_public_keys = '{}', root_password_hash = NULL, root_password_enc = NULL,
    app_token_hash = NULL, app_script_enc = NULL, tags = '{}', notes = '', delete_at = NULL, updated_at = now() WHERE id = $1`, [s.id, toId]);
  await db.query("UPDATE subscriptions SET owner_id = $2, updated_at = now() WHERE server_id = $1 AND status NOT IN ('cancelled', 'ended')", [s.id, toId]);
  await db.query('DELETE FROM server_favorites WHERE server_id = $1 AND user_id = $2', [s.id, s.owner_id]);
  await db.query('DELETE FROM server_updates WHERE server_id = $1', [s.id]);
  await db.query('DELETE FROM power_schedules WHERE server_id = $1', [s.id]);
  await db.query("UPDATE backups SET owner_id = $2 WHERE server_id = $1 AND status <> 'deleted'", [s.id, toId]);
  await db.query('UPDATE os_images SET source_server_id = NULL WHERE source_server_id = $1', [s.id]);
  await db.query('UPDATE tickets SET server_id = NULL WHERE server_id = $1 AND owner_id = $2', [s.id, s.owner_id]);
}
// After the commit: consoles the previous owner has open are closed. The gateway closes by account, so one they have
// open on another server of theirs closes too and is simply opened again.
const ownerLeft = (s: Server) => revokeConsoles({ userId: s.owner_id });

const columns = `t.id, t.status, t.note, t.created_at AS "createdAt", t.expires_at AS "expiresAt", t.decided_at AS "decidedAt",
  s.id AS "serverId", s.name AS "serverName", s.vcpu, s.memory_mb AS "memoryMb", s.disk_gb AS "diskGb", s.price_monthly::text AS "priceMonthly", trim(s.currency) AS currency,
  f.email AS "fromEmail", f.name AS "fromName", r.email AS "toEmail", r.name AS "toName"`;
const joins = 'FROM server_transfers t JOIN servers s ON s.id = t.server_id JOIN users f ON f.id = t.from_id JOIN users r ON r.id = t.to_id';

@Controller() @UseGuards(SessionGuard)
export class TransfersController {
  // Offers waiting for this account, and the ones it made (the last 30 days).
  @Get('transfers')
  async list(@Req() req: AuthedRequest) {
    await pool.query("UPDATE server_transfers SET status = 'expired', decided_at = now() WHERE status = 'pending' AND expires_at < now()");
    const { rows: incoming } = await pool.query(`SELECT ${columns} ${joins} WHERE t.to_id = $1 AND (t.status = 'pending' OR t.created_at > now() - interval '30 days') ORDER BY t.created_at DESC`, [req.user.id]);
    const { rows: outgoing } = await pool.query(`SELECT ${columns} ${joins} WHERE t.from_id = $1 AND (t.status = 'pending' OR t.created_at > now() - interval '30 days') ORDER BY t.created_at DESC`, [req.user.id]);
    return { incoming, outgoing };
  }

  // The owner offers the server to the account with this e-mail. The checks run now and again at acceptance.
  @Post('servers/:id/transfer') @HttpCode(201)
  async offer(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { email: 'INVALID_EMAIL' });
    const { rows: [own] } = await pool.query("SELECT id FROM servers WHERE id = $1 AND owner_id = $2 AND state <> 'deleted'", [id, req.user.id]);
    if (!own) throw apiError(404, 'NOT_FOUND', 'Unknown server');
    const { rows: [to] } = await pool.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
    // This tells whether an e-mail has an account; only a server's owner can ask, and the recipient must exist to accept anyway.
    if (!to) throw apiError(400, 'VALIDATION_FAILED', 'No account with this e-mail', { email: 'NO_SUCH_ACCOUNT' });
    const s = await checkTransfer(pool, id, to.id);
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 300) || null : null;
    await pool.query("UPDATE server_transfers SET status = 'expired', decided_at = now() WHERE server_id = $1 AND status = 'pending' AND expires_at < now()", [id]);
    try {
      const { rows: [t] } = await pool.query('INSERT INTO server_transfers (server_id, from_id, to_id, note) VALUES ($1, $2, $3, $4) RETURNING id', [id, req.user.id, to.id, note]);
      await audit(req, 'server.transfer_offered', 'success', req.user.id, { serverId: id, target: to.id, transferId: t.id });
      await notify('server.transfer', [to.id], { serverId: id, name: s.name, email: req.user.email, step: 'offered' });
      return { id: t.id };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw blocked('ALREADY_OFFERED');
      throw e;
    }
  }

  @Post('transfers/:id/accept') @HttpCode(200)
  async accept(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const client = await pool.connect();
    let t: { server_id: string; from_id: string };
    let name: string, moved: Server;
    try {
      await client.query('BEGIN');
      ({ rows: [t] } = await client.query("SELECT * FROM server_transfers WHERE id = $1 AND to_id = $2 AND status = 'pending' AND expires_at > now() FOR UPDATE", [id, req.user.id]));
      if (!t) throw apiError(404, 'NOT_FOUND', 'No open offer');
      await client.query('SELECT 1 FROM servers WHERE id = $1 FOR UPDATE', [t.server_id]);
      const s = await checkTransfer(client, t.server_id, req.user.id);
      if (s.owner_id !== t.from_id) throw blocked('SAME_OWNER');
      name = s.name;
      moved = s;
      await moveServer(client, s, req.user.id);
      await client.query("UPDATE server_transfers SET status = 'accepted', decided_at = now() WHERE id = $1", [id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await ownerLeft(moved);
    await audit(req, 'server.transfer_accepted', 'success', req.user.id, { serverId: t.server_id, transferId: id, from: t.from_id });
    await notify('server.transfer', [t.from_id], { serverId: t.server_id, name, email: req.user.email, step: 'accepted' });
    return { serverId: t.server_id };
  }

  @Post('transfers/:id/decline') @HttpCode(204)
  async decline(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [t] } = await pool.query(`UPDATE server_transfers t SET status = 'declined', decided_at = now() FROM servers s
      WHERE t.id = $1 AND t.to_id = $2 AND t.status = 'pending' AND s.id = t.server_id RETURNING t.server_id, t.from_id, s.name`, [id, req.user.id]);
    if (!t) throw apiError(404, 'NOT_FOUND', 'No open offer');
    await audit(req, 'server.transfer_declined', 'success', req.user.id, { serverId: t.server_id, transferId: id });
    await notify('server.transfer', [t.from_id], { serverId: t.server_id, name: t.name, email: req.user.email, step: 'declined' });
  }

  // The owner withdraws an offer not yet answered.
  @Post('transfers/:id/cancel') @HttpCode(204)
  async cancel(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await pool.query("UPDATE server_transfers SET status = 'cancelled', decided_at = now() WHERE id = $1 AND from_id = $2 AND status = 'pending'", [id, req.user.id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'No open offer');
    await audit(req, 'server.transfer_cancelled', 'success', req.user.id, { transferId: id });
  }
}

@Controller('admin/servers') @UseGuards(PermissionGuard)
export class TransfersAdminController {
  // Staff move a server to another account at once (a company's servers to a colleague, an account merge), with the same checks.
  @Put(':id/owner') @Can('servers.manage_all')
  async move(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const { rows: [to] } = await pool.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
    if (!to) throw apiError(400, 'VALIDATION_FAILED', 'No account with this e-mail', { email: 'NO_SUCH_ACCOUNT' });
    const client = await pool.connect();
    let s: Server;
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM servers WHERE id = $1 FOR UPDATE', [id]);
      s = await checkTransfer(client, id, to.id);
      await moveServer(client, s, to.id);
      await client.query("UPDATE server_transfers SET status = 'cancelled', decided_at = now() WHERE server_id = $1 AND status = 'pending'", [id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await ownerLeft(s);
    await audit(req, 'server.owner_changed', 'success', req.user.id, { serverId: id, from: s.owner_id, to: to.id });
    await notify('server.transfer', [to.id, s.owner_id], { serverId: id, name: s.name, email: email, step: 'moved' });
    return { ok: true };
  }
}
