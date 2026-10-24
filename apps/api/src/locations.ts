// Locations: the places servers run in, shown to customers when ordering (flag, city, datacenter, status,
// latency test) and on the server page. Pools are assigned to a location; its name is copied to the pool.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { isIP } from 'node:net';
import { pool } from './db';
import { apiError } from './errors';
import { audit, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';

type Input = Record<string, unknown>;
export const locationColumns = `l.id, l.name, l.city, l.country_code AS "countryCode", l.datacenter, l.description, l.latitude::float8 AS latitude,
  l.longitude::float8 AS longitude, l.status, l.ping_url AS "pingUrl", l.looking_glass_url AS "lookingGlassUrl", host(l.test_ip) AS "testIp", l.sort`;

function readLocation(b: Input) {
  const fields: Record<string, string> = {};
  const text = (k: string, max: number, required = false) => {
    const v = typeof b[k] === 'string' ? (b[k] as string).trim() : '';
    if (required && !v) fields[k] = 'REQUIRED'; else if (v.length > max) fields[k] = 'TOO_LONG';
    return v;
  };
  const url = (k: string) => { const v = text(k, 300); if (v && !/^https?:\/\/[^\s]+$/i.test(v)) fields[k] = 'INVALID_URL'; return v; };
  const coord = (k: string, max: number) => {
    if (b[k] === null || b[k] === undefined || b[k] === '') return null;
    const n = Number(b[k]);
    if (!Number.isFinite(n) || Math.abs(n) > max) { fields[k] = 'OUT_OF_RANGE'; return null; }
    return Math.round(n * 1e5) / 1e5;
  };
  const v = {
    name: text('name', 100, true), city: text('city', 100), countryCode: text('countryCode', 2).toUpperCase(), datacenter: text('datacenter', 100),
    description: text('description', 500), latitude: coord('latitude', 90), longitude: coord('longitude', 180),
    status: ['active', 'maintenance', 'hidden'].includes(String(b.status)) ? String(b.status) : 'active',
    pingUrl: url('pingUrl'), lookingGlassUrl: url('lookingGlassUrl'), testIp: text('testIp', 45) || null,
    sort: Number.isInteger(b.sort) ? Number(b.sort) : 0,
  };
  if (v.countryCode && !/^[A-Z]{2}$/.test(v.countryCode)) fields.countryCode = 'INVALID_VALUE';
  if (v.testIp && !isIP(v.testIp)) fields.testIp = 'INVALID_IP';
  if ((v.latitude === null) !== (v.longitude === null) && !fields.latitude && !fields.longitude) fields[v.latitude === null ? 'latitude' : 'longitude'] = 'REQUIRED';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return v;
}
const params = (v: ReturnType<typeof readLocation>) => [v.name, v.city, v.countryCode, v.datacenter, v.description, v.latitude, v.longitude, v.status, v.pingUrl, v.lookingGlassUrl, v.testIp, v.sort];
const nameTaken = (e: { code?: string }) => { if (e.code === '23505') throw apiError(409, 'VALIDATION_FAILED', 'Name taken', { name: 'NAME_TAKEN' }); throw e; };

@Controller('admin') @UseGuards(PermissionGuard)
export class LocationsController {
  @Get('locations') @Can('catalog.view', 'catalog.manage', 'dashboard.view')
  async list() {
    const { rows } = await pool.query(`SELECT ${locationColumns},
      (SELECT count(*)::int FROM resource_pools p WHERE p.location_id = l.id) AS pools,
      (SELECT count(*)::int FROM servers s JOIN resource_pools p ON p.id = s.pool_id WHERE p.location_id = l.id AND s.state <> 'deleted') AS servers
      FROM locations l ORDER BY l.sort, l.name`);
    return { locations: rows };
  }

  @Post('locations') @HttpCode(201) @Can('catalog.manage')
  async create(@Req() req: AuthedRequest, @Body() body: Input) {
    const v = readLocation(body ?? {});
    const { rows: [l] } = await pool.query(`INSERT INTO locations (name, city, country_code, datacenter, description, latitude, longitude, status, ping_url, looking_glass_url, test_ip, sort)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, params(v)).catch(nameTaken);
    await audit(req, 'catalog.location_created', 'success', req.user.id, { id: l.id, name: v.name });
    return { id: l.id };
  }

  @Put('locations/:id') @Can('catalog.manage')
  async update(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const v = readLocation(body ?? {});
    const { rowCount } = await pool.query(`UPDATE locations SET name=$2, city=$3, country_code=$4, datacenter=$5, description=$6, latitude=$7, longitude=$8, status=$9,
      ping_url=$10, looking_glass_url=$11, test_ip=$12, sort=$13, updated_at=now() WHERE id=$1`, [id, ...params(v)]).catch(nameTaken);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown location');
    await pool.query('UPDATE resource_pools SET location = $2 WHERE location_id = $1', [id, v.name]);
    await audit(req, 'catalog.location_updated', 'success', req.user.id, { id, status: v.status });
    return { id };
  }

  @Delete('locations/:id') @HttpCode(204) @Can('catalog.manage')
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM resource_pools WHERE location_id = $1', [id]);
    if (n.n) throw apiError(409, 'IN_USE', 'Pools are assigned to this location');
    const { rowCount } = await pool.query('DELETE FROM locations WHERE id = $1', [id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown location');
    await audit(req, 'catalog.location_deleted', 'success', req.user.id, { id });
  }

  // Moves a pool to a location (or out of every location: null).
  @Put('pools/:id/location') @Can('catalog.manage')
  async assign(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const locationId = typeof body?.locationId === 'string' && body.locationId ? body.locationId : null;
    let name = '';
    if (locationId) {
      const { rows: [l] } = await pool.query('SELECT name FROM locations WHERE id = $1', [locationId]).catch(() => ({ rows: [] }));
      if (!l) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { locationId: 'INVALID_VALUE' });
      name = l.name;
    }
    const { rowCount } = await pool.query('UPDATE resource_pools SET location_id = $2, location = $3, updated_at = now() WHERE id = $1', [id, locationId, name]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown pool');
    await audit(req, 'catalog.pool_location', 'success', req.user.id, { id, locationId });
    return { id, locationId };
  }
}
