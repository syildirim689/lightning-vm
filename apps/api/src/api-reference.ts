// The API reference, built from the running code: every route of every controller (method, path, the guard and
// the permissions it asks for) joined with its words from api-docs/. Served as JSON for the panel's reference page
// (and its PDF) and as an OpenAPI 3.1 document for tools that generate clients.
import { Controller, Get, Query, Req, RequestMethod, UseGuards } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { SessionGuard, type AuthedRequest } from './auth';
import { docs } from './api-docs';
import { tags } from './api-docs/tags';
import type { EndpointDoc, Field, Text } from './api-docs/types';
import { PERMISSION } from './rbac';
import { getSettings } from './settings-store';

// main.ts hands over its controller list (importing it here would be circular).
export const reference: { controllers: Function[] } = { controllers: [] };

export type Route = { key: string; method: string; path: string; controller: string; handler: string;
  auth: 'public' | 'session' | 'permission' | 'special'; permissions: string[]; status: number };

const methods: Partial<Record<RequestMethod, string>> = { [RequestMethod.GET]: 'GET', [RequestMethod.POST]: 'POST', [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH', [RequestMethod.DELETE]: 'DELETE', [RequestMethod.ALL]: 'ALL' };
const joinPath = (...parts: string[]) => ('/' + parts.join('/')).replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');

export function routesOf(controllers: Function[]): Route[] {
  const out: Route[] = [];
  for (const cls of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
    const classGuards: Function[] = Reflect.getMetadata(GUARDS_METADATA, cls) ?? [];
    const proto = cls.prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const fn = proto[name];
      if (name === 'constructor' || typeof fn !== 'function') continue;
      const m = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
      const sub = Reflect.getMetadata(PATH_METADATA, fn);
      if (m === undefined || sub === undefined || !methods[m]) continue;
      const method = methods[m]!;
      const path = joinPath(base, String(sub));
      const guards = [...classGuards, ...((Reflect.getMetadata(GUARDS_METADATA, fn) as Function[] | undefined) ?? [])].map((g) => g.name);
      const permissions: string[] = Reflect.getMetadata(PERMISSION, fn) ?? [];
      const auth = guards.includes('PermissionGuard') ? 'permission' : guards.includes('SessionGuard') ? 'session' : guards.length ? 'special' : 'public';
      const status = Number(Reflect.getMetadata(HTTP_CODE_METADATA, fn) ?? (method === 'POST' ? 201 : 200));
      out.push({ key: `${method} ${path}`, method, path, controller: cls.name, handler: name, auth, permissions, status });
    }
  }
  return out;
}

export type Endpoint = Route & EndpointDoc & { allowed: boolean; documented: boolean };

const fallback = (r: Route): EndpointDoc => ({ tag: 'internal', summary: { tr: r.handler, en: r.handler }, internal: true });

export function endpoints(permissions: string[] | null): Endpoint[] {
  const order = Object.keys(tags);
  return routesOf(reference.controllers).map((r) => {
    const d = docs[r.key];
    const allowed = permissions === null || r.auth !== 'permission' || !r.permissions.length || permissions.includes('*') || r.permissions.some((p) => permissions.includes(p));
    return { ...r, ...(d ?? fallback(r)), allowed, documented: !!d };
  }).sort((a, b) => (order.indexOf(a.tag) - order.indexOf(b.tag)) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

// The common answers every route may give; the reference prints them once.
export const commonErrors: { status: number; code: string; text: Text }[] = [
  { status: 400, code: 'VALIDATION_FAILED', text: { tr: 'Girdi geçersiz; "fields" hangi alanın neden reddedildiğini söyler.', en: 'Invalid input; "fields" says which field was refused and why.' } },
  { status: 401, code: 'UNAUTHENTICATED', text: { tr: 'Anahtar yok, bilinmiyor, süresi dolmuş veya silinmiş.', en: 'No token, or it is unknown, expired or removed.' } },
  { status: 403, code: 'FORBIDDEN', text: { tr: 'Anahtarın sahibinin (veya anahtarın) bu işlem için yetkisi yok.', en: 'The token (or its owner) lacks the permission.' } },
  { status: 403, code: 'TOKEN_READ_ONLY', text: { tr: 'Salt okunur anahtarla değişiklik denendi.', en: 'A read-only token tried to change something.' } },
  { status: 403, code: 'TOKEN_NOT_ALLOWED', text: { tr: 'Bu işlem yalnızca panelden yapılabilir.', en: 'Only the panel can do this.' } },
  { status: 403, code: 'TOKEN_ADDRESS_NOT_ALLOWED', text: { tr: 'Anahtar bu IP adresinden kullanılamaz (anahtarın veya Ayarlar → API\'nin adres kuralı).', en: 'The token may not be used from this address (its own or Settings → API rule).' } },
  { status: 404, code: 'NOT_FOUND', text: { tr: 'Kayıt yok ya da size ait değil.', en: 'No such record, or it is not yours.' } },
  { status: 409, code: 'OPERATION_IN_PROGRESS', text: { tr: 'Sunucuda başka bir işlem sürüyor.', en: 'Another operation is running on the server.' } },
  { status: 429, code: 'RATE_LIMITED', text: { tr: 'Anahtarın dakikalık istek sınırı doldu; Retry-After kadar bekleyin.', en: 'The token\'s requests per minute are used up; wait Retry-After seconds.' } },
  { status: 503, code: 'DEPENDENCY_UNAVAILABLE', text: { tr: 'Veritabanı, Redis veya VMware adaptörü geçici olarak yanıt vermiyor.', en: 'The database, Redis or the VMware adapter is not answering for now.' } },
];

// ---- OpenAPI 3.1 ----
type Schema = Record<string, unknown>;
function schemaOf(f: Field): Schema {
  const t = f.type.trim();
  if (t.endsWith('[]')) return { type: 'array', items: schemaOf({ ...f, type: t.slice(0, -2), values: f.values }) };
  const base: Schema = t === 'integer' || t === 'number' || t === 'boolean' || t === 'object' ? { type: t }
    : t === 'uuid' ? { type: 'string', format: 'uuid' } : { type: 'string' };
  if (f.values?.length) base.enum = f.values;
  return base;
}
// "tls.mode" and "items[].name" become nested properties.
function bodySchema(fields: Field[], lang: 'tr' | 'en'): Schema {
  const root: Schema = { type: 'object', properties: {} as Record<string, Schema>, required: [] as string[] };
  for (const f of fields) {
    // "(settings)": the body takes another route's fields; described in words, any property allowed.
    if (f.name.startsWith('(')) { root.additionalProperties = true; continue; }
    const parts = f.name.split('.');
    let node = root;
    parts.forEach((raw, i) => {
      const array = raw.endsWith('[]') && i < parts.length - 1;
      const name = array ? raw.slice(0, -2) : raw;
      const props = (node.properties ??= {}) as Record<string, Schema>;
      if (i === parts.length - 1) {
        props[name] = { ...schemaOf({ ...f, name }), description: f.text[lang] };
        if (f.required) ((node.required ??= []) as string[]).push(name);
        return;
      }
      props[name] ??= array ? { type: 'array', items: { type: 'object', properties: {} } } : { type: 'object', properties: {} };
      node = array ? (props[name].items as Schema) : props[name];
    });
  }
  if (!(root.required as string[]).length) delete root.required;
  return root;
}

export function openApi(baseUrl: string, lang: 'tr' | 'en', only: Endpoint[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of only.filter((x) => !x.internal)) {
    const path = e.path.replace(/:(\w+)/g, '{$1}');
    const perm = e.permissions.length ? (lang === 'tr' ? `Gereken yetki: ${e.permissions.join(' veya ')}.` : `Permission: ${e.permissions.join(' or ')}.`) : '';
    const notes = [e.details?.[lang], perm, e.tokens === false ? (lang === 'tr' ? 'API anahtarıyla kullanılamaz.' : 'Not available with an API token.') : '',
      e.idempotencyKey ? (lang === 'tr' ? 'Idempotency-Key başlığı gerekir.' : 'Needs an Idempotency-Key header.') : ''].filter(Boolean).join('\n\n');
    const parameters = [
      ...(e.params ?? []).map((p) => ({ name: p.name, in: 'path', required: true, description: p.text[lang], schema: schemaOf(p) })),
      ...(e.query ?? []).map((p) => ({ name: p.name, in: 'query', required: !!p.required, description: p.text[lang], schema: schemaOf(p) })),
      ...(e.idempotencyKey ? [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 100 } }] : []),
      // Path parameters without words still have to be declared.
      ...[...e.path.matchAll(/:(\w+)/g)].map((m) => m[1]).filter((n) => !(e.params ?? []).some((p) => p.name === n))
        .map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
    ];
    (paths[path] ??= {})[e.method.toLowerCase()] = {
      operationId: `${e.controller.replace(/Controller$/, '')}_${e.handler}`,
      tags: [tags[e.tag]?.name[lang] ?? e.tag],
      summary: e.summary[lang],
      ...(notes && { description: notes }),
      ...(parameters.length && { parameters }),
      ...(e.body?.length && { requestBody: { required: true, content: { 'application/json': { schema: bodySchema(e.body, lang), ...(e.example !== undefined && { example: e.example }) } } } }),
      responses: {
        [String(e.status)]: { description: e.returns?.[lang] ?? (e.status === 204 ? 'No content' : 'OK') },
        default: { description: lang === 'tr' ? 'Hata' : 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
      ...(e.auth === 'public' ? { security: [] } : {}),
      'x-permissions': e.permissions,
      ...(e.errors?.length && { 'x-error-codes': e.errors }),
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Lightning VM API', version: process.env.APP_VERSION || 'dev',
      description: lang === 'tr' ? 'Panelin yaptığı her şey bu HTTP API üzerinden yapılır. Kimlik: Authorization: Bearer lvm_… (Hesap → API).'
        : 'Everything the panel does goes through this HTTP API. Authenticate with Authorization: Bearer lvm_… (Account → API).' },
    servers: [{ url: baseUrl }],
    tags: Object.entries(tags).filter(([k]) => k !== 'internal').map(([, t]) => ({ name: t.name[lang], description: t.text[lang] })),
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'lvm_…' } },
      schemas: { Error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' },
        fields: { type: 'object', additionalProperties: { type: 'string' } } } } },
    },
    security: [{ bearerAuth: [] }],
  };
}

const baseOf = (req: AuthedRequest) => `${req.protocol}://${req.hostname}/api`;

@Controller('docs') @UseGuards(SessionGuard)
export class ApiDocsController {
  // Everything the reference page shows. "allowed" says whether the caller's permissions reach a route.
  @Get('reference')
  async reference(@Req() req: AuthedRequest) {
    const list = endpoints(req.user.permissions);
    const [api, security] = await Promise.all([getSettings('api'), getSettings('security')]);
    return { baseUrl: baseOf(req), version: process.env.APP_VERSION || 'dev', generatedAt: new Date().toISOString(),
      // The rules in force, so the guide states real numbers.
      limits: { rateLimit: api.rateLimit, maxDays: api.maxDays, who: security.apiTokens ?? 'everyone', networks: api.networks.length > 0 },
      tags: Object.entries(tags).map(([key, t]) => ({ key, ...t, count: list.filter((e) => e.tag === key).length })),
      commonErrors, endpoints: list };
  }

  // OpenAPI 3.1. ?lang=tr for Turkish words; ?mine=1 only the routes the caller may use.
  @Get('openapi.json')
  openapi(@Req() req: AuthedRequest, @Query('lang') lang?: string, @Query('mine') mine?: string) {
    const list = endpoints(req.user.permissions);
    return openApi(baseOf(req), lang === 'tr' ? 'tr' : 'en', mine === '1' ? list.filter((e) => e.allowed) : list);
  }
}
