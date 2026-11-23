// GET /servers/:id/hints: the facts for server-hint-rules.ts, for whoever may see the server (findServer: its owner,
// the owner's reseller, staff who see all servers). What the viewer may do there decides what is pointed at (a hint
// about backups only for someone who may take one). Hidden ones are the viewer's own insight dismissals
// (PUT /insights/dismissals with the hint's key): counted, not listed.
import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthedRequest } from './auth';
import { backupTarget } from './backups';
import { pool } from './db';
import { oldSnapshots } from './insights';
import { serverHints, snapshotDays, type HintFacts } from './server-hint-rules';
import { allowedFor, findServer } from './servers';

@Controller('servers/:id/hints') @UseGuards(SessionGuard)
export class ServerHintsController {
  @Get()
  async list(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id);
    const allowed = await allowedFor(req) as Record<string, boolean>;
    const [{ rows: [b] }, { rows: [fw] }, target, old] = await Promise.all([
      pool.query("SELECT max(coalesce(finished_at, created_at)) AS last FROM backups WHERE server_id = $1 AND status = 'ready'", [id]),
      pool.query(`SELECT c.operations->>'firewall' = 'true' AS supported, (SELECT count(*)::int FROM firewall_servers fs WHERE fs.server_id = $1) AS attached
        FROM resource_pools p JOIN vmware_connections c ON c.id = p.connection_id WHERE p.id = $2`, [id, s.pool_id]),
      s.pool_id ? backupTarget(s.pool_id) : null,
      // Asks the platform (cached for hours, skipped when it does not answer): only for someone who may handle snapshots.
      allowed.snapshots && s.state === 'ready' ? oldSnapshots(s.owner_id, id).catch(() => []) : [],
    ]);
    const facts: HintFacts = {
      id, state: s.state, deleting: !!s.delete_at, createdAt: new Date(s.created_at).toISOString(),
      backups: { allowed: !!allowed.backups, available: !!target, lastReady: b?.last ? new Date(b.last).toISOString() : null },
      firewall: { supported: !!fw?.supported, attached: fw?.attached ?? 0 },
      rootPassword: { kept: !!s.root_password_enc, allowed: !!allowed.rootPassword },
      snapshots: { allowed: !!allowed.snapshots, old: old.find((x) => x.id === id)?.n ?? 0 },
    };
    const all = serverHints(facts);
    const { rows } = all.length ? await pool.query('SELECT key FROM insight_dismissals WHERE user_id = $1 AND key = ANY($2) AND (until IS NULL OR until > now())', [req.user.id, all.map((h) => h.key)]) : { rows: [] };
    const hide = new Set(rows.map((r) => r.key as string));
    return { hints: all.filter((h) => !hide.has(h.key)), hidden: all.filter((h) => hide.has(h.key)).length, snapshotDays };
  }
}
