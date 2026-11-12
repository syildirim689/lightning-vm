// The API reference as the panel shows and prints it: types of GET /docs/reference, example code for a route
// (cURL, JavaScript, Python) and the guide's chapters. The PDF (api-pdf.ts) and the page use the same pieces.
export type Lang = 'tr' | 'en';
export type Text = { tr: string; en: string };
export type Field = { name: string; type: string; required?: boolean; values?: string[]; text: Text };
export type Endpoint = {
  key: string; method: string; path: string; tag: string; auth: 'public' | 'session' | 'permission' | 'special'; permissions: string[]; status: number;
  allowed: boolean; summary: Text; details?: Text; params?: Field[]; query?: Field[]; body?: Field[]; example?: unknown; returns?: Text; errors?: string[];
  idempotencyKey?: boolean; tokens?: false; internal?: true;
};
export type Reference = { baseUrl: string; version: string; generatedAt: string; limits: { rateLimit: number; maxDays: number; who: 'everyone' | 'staff' | 'off'; networks: boolean };
  tags: { key: string; name: Text; text: Text; count: number }[]; commonErrors: { status: number; code: string; text: Text }[]; endpoints: Endpoint[] };

// The anchor of a route on the page (#post-servers-id-actions).
export const anchor = (e: Pick<Endpoint, 'method' | 'path'>) => `${e.method}${e.path}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');

// A body to show when the route has no written example: its required fields (all fields if none is required).
function sampleValue(f: Field): unknown {
  if (f.values?.length) return f.values[0];
  const t = f.type.replace(/\[\]$/, '');
  const one = t === 'integer' || t === 'number' ? 1 : t === 'boolean' ? true : t === 'uuid' ? '00000000-0000-0000-0000-000000000000' : t === 'object' ? {} : '…';
  return f.type.endsWith('[]') ? [one] : one;
}
export function exampleBody(e: Endpoint): unknown {
  if (e.example !== undefined) return e.example;
  const fields = (e.body ?? []).filter((f) => !f.name.startsWith('('));
  if (!fields.length) return undefined;
  const pick = fields.some((f) => f.required) ? fields.filter((f) => f.required) : fields;
  const out: Record<string, unknown> = {};
  for (const f of pick) {
    const parts = f.name.replace(/\[\]/g, '').split('.');
    let node = out;
    parts.forEach((p, i) => { if (i === parts.length - 1) node[p] = sampleValue(f); else node = (node[p] ??= {}) as Record<string, unknown>; });
  }
  return out;
}

const queryOf = (e: Endpoint) => (e.query ?? []).filter((q) => q.required).map((q) => `${q.name}=${encodeURIComponent(String(sampleValue(q)))}`).join('&');
const hasBody = (e: Endpoint) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method) && exampleBody(e) !== undefined;

export function curl(e: Endpoint) {
  const q = queryOf(e);
  const url = `"$LVM_URL${e.path.replace(/:(\w+)/g, '$$$1')}${q ? `?${q}` : ''}"`;
  const lines = [`curl${e.method === 'GET' ? '' : ` -X ${e.method}`} ${url}`, `  -H "Authorization: Bearer $LVM_TOKEN"`];
  if (e.idempotencyKey) lines.push(`  -H "Idempotency-Key: $(uuidgen)"`);
  if (hasBody(e)) lines.push(`  -H "Content-Type: application/json"`, `  -d '${JSON.stringify(exampleBody(e))}'`);
  return lines.join(' \\\n');
}

export function javascript(e: Endpoint) {
  const q = queryOf(e);
  const headers = ['Authorization: `Bearer ${process.env.LVM_TOKEN}`', ...(hasBody(e) ? ["'Content-Type': 'application/json'"] : []),
    ...(e.idempotencyKey ? ["'Idempotency-Key': crypto.randomUUID()"] : [])];
  const body = hasBody(e) ? `,\n  body: JSON.stringify(${JSON.stringify(exampleBody(e), null, 2).replace(/\n/g, '\n  ')})` : '';
  return `const res = await fetch(\`\${process.env.LVM_URL}${e.path.replace(/:(\w+)/g, '${$1}')}${q ? `?${q}` : ''}\`, {
  method: '${e.method}',
  headers: { ${headers.join(', ')} }${body},
});
if (!res.ok) throw new Error((await res.json()).code); // { code, message, fields? }
${e.status === 204 || e.status === 202 ? '' : 'const data = await res.json();'}`.trimEnd();
}

export function python(e: Endpoint) {
  const q = queryOf(e);
  const headers = ['"Authorization": f"Bearer {LVM_TOKEN}"', ...(e.idempotencyKey ? ['"Idempotency-Key": str(uuid.uuid4())'] : [])];
  const body = hasBody(e) ? `,\n    json=${JSON.stringify(exampleBody(e)).replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None')}` : '';
  return `${e.idempotencyKey ? 'import uuid\n' : ''}import os, requests

LVM_URL, LVM_TOKEN = os.environ["LVM_URL"], os.environ["LVM_TOKEN"]
r = requests.${e.method.toLowerCase()}(
    f"{LVM_URL}${e.path.replace(/:(\w+)/g, '{$1}')}${q ? `?${q}` : ''}",
    headers={${headers.join(', ')}}${body},
    timeout=30,
)
r.raise_for_status()${e.status === 204 || e.status === 202 ? '' : '\nprint(r.json())'}`;
}

// Chapters of the guide: their words are messages ApiDocs.guide.<id>.title / .p1… ; code is the same in both languages.
export const guide: { id: string; paras: number; code?: (base: string) => string; errors?: true }[] = [
  { id: 'start', paras: 3, code: (base) => `export LVM_URL=${base}
export LVM_TOKEN=lvm_...            # Account → API
curl -s "$LVM_URL/auth/me" -H "Authorization: Bearer $LVM_TOKEN"` },
  { id: 'auth', paras: 4 },
  { id: 'format', paras: 3, code: () => `HTTP/1.1 400 Bad Request
Content-Type: application/json

{ "code": "VALIDATION_FAILED", "message": "Invalid input", "fields": { "name": "REQUIRED" } }` },
  { id: 'errors', paras: 1, errors: true },
  { id: 'idempotency', paras: 2, code: () => `curl -X POST "$LVM_URL/servers" \\
  -H "Authorization: Bearer $LVM_TOKEN" \\
  -H "Idempotency-Key: 6f1c2a9e-order-web-1" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"package","poolId":"…","packageId":"…","imageId":"…","name":"web-1","sshKeyIds":[]}'` },
  { id: 'limits', paras: 3, code: () => `X-RateLimit-Limit: 600
X-RateLimit-Remaining: 597
X-RateLimit-Reset: 1762953660      # Unix seconds; on 429 also Retry-After` },
  { id: 'operations', paras: 3, code: () => `# Start, then poll until the server leaves its "…ing" state
curl -X POST "$LVM_URL/servers/$id/actions" -H "Authorization: Bearer $LVM_TOKEN" \\
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" -d '{"action":"power_off"}'
while sleep 5; do
  curl -s "$LVM_URL/servers/$id" -H "Authorization: Bearer $LVM_TOKEN" | jq -r .server.state
done` },
  { id: 'webhooks', paras: 3, code: () => `import { createHmac, timingSafeEqual } from 'node:crypto';
// header: X-Lightning-Signature: t=<unix seconds>,v1=<hex>
function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;          // older than 5 minutes
  const mac = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return mac.length === v1.length && timingSafeEqual(Buffer.from(mac), Buffer.from(v1));
}` },
  { id: 'security', paras: 4 },
];
