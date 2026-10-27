// Personal images (migration 052): a customer saves one of their servers as an image (its disk at that moment, a
// template next to it in vCenter) and orders new servers or reinstalls from it. Nobody else sees it.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { pool } from './db';
import { apiError } from './errors';
import { findServer, hashOf, startOperation } from './servers';
import { callAdapter, storedTarget } from './vmware';

export const MAX_IMAGES = 5;

@Controller() @UseGuards(SessionGuard)
export class ImagesController {
  @Get('images/mine')
  async mine(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT i.id, i.name, i.family, i.min_disk_gb AS "minDiskGb", i.created_at AS "createdAt", s.name AS "sourceName",
        (SELECT count(*)::int FROM servers x WHERE x.image_id = i.id AND x.state <> 'deleted') AS servers
      FROM os_images i LEFT JOIN servers s ON s.id = i.source_server_id WHERE i.owner_id = $1 AND i.active ORDER BY i.created_at DESC`, [req.user.id]);
    return { images: rows, max: MAX_IMAGES };
  }

  // The server keeps running; the image is its disk as it is now (stop it first for a clean copy of a database).
  @Post('servers/:id/image') @HttpCode(202)
  async create(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const s = await findServer(req, id, true);
    if (s.owner_id !== req.user.id) throw apiError(403, 'OWNER_ONLY', 'Only the owner can make an image of a server');
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!name) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { name: 'REQUIRED' });
    if (!['ready', 'error'].includes(s.state) || !s.vm_moref) throw apiError(409, 'INVALID_SERVER_STATE', 'Not possible in this state');
    if ((await pool.query('SELECT 1 FROM os_images WHERE owner_id = $1 AND active', [req.user.id])).rowCount! >= MAX_IMAGES) throw apiError(409, 'LIMIT_REACHED', 'Remove an image first');
    const imageId = randomUUID();
    const operation = await startOperation(req, s, 'image_create', `image:${imageId}`, hashOf({ id, image: imageId }), { imageId, name });
    await audit(req, 'image.created', 'success', req.user.id, { serverId: id, imageId });
    return { imageId, operation };
  }

  // Its template goes too. An image servers still run from is kept for them (hidden), so they can be reinstalled later.
  @Delete('images/:id') @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [i] } = await pool.query('SELECT * FROM os_images WHERE id = $1 AND owner_id = $2 AND active', [id, req.user.id]);
    if (!i) throw apiError(404, 'NOT_FOUND', 'Unknown image');
    if ((await pool.query("SELECT 1 FROM servers WHERE image_id = $1 AND state <> 'deleted'", [id])).rowCount) throw apiError(409, 'IMAGE_IN_USE', 'Servers still run from this image');
    const { rows: [c] } = await pool.query('SELECT * FROM vmware_connections WHERE id = $1', [i.connection_id]);
    await callAdapter('/v1/image/delete', { ...storedTarget(c), name: `lvm-img-${id}` }, 120_000);
    await pool.query('UPDATE os_images SET active = false WHERE id = $1', [id]);
    await audit(req, 'image.deleted', 'success', req.user.id, { imageId: id });
  }
}
