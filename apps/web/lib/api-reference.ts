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

// ---- Running a request from the page ("Try it", api-docs/try-request.tsx) ----
// The request is built here from the route as the reference describes it and what the person typed, so the page can
// show it before it is sent and send exactly that. It always goes to this panel's own API (a path under /api made
// from the documented route), with the signed-in session the browser adds by itself: the API checks permissions and
// limits as for any other request of that session.

// Why a route cannot be run from the page (null: it can). Internal routes are the setup wizard, the providers'
// callbacks and the sign-in flows; panel-only ones hand out or change secrets (API tokens, webhook secrets, the
// console) and stay on their own screens, as they do for API tokens; a route the account may not call is not offered
// either (the API would refuse it).
export function notRunnable(e: Endpoint): 'internal' | 'panelOnly' | 'notAllowed' | null {
  if (e.internal || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method)) return 'internal';
  if (e.tokens === false) return 'panelOnly';
  if (!e.allowed) return 'notAllowed';
  return null;
}
export const pathParams = (e: Pick<Endpoint, 'path'>) => [...e.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
// The query fields the route documents (nothing else can be added from the page).
export const queryFields = (e: Endpoint) => (e.query ?? []).filter((q) => /^[\w.[\]-]+$/.test(q.name));
export const takesBody = (e: Pick<Endpoint, 'method'>) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method);

export type RunInput = { params: Record<string, string>; query: Record<string, string>; body: string; idempotencyKey?: string };
export type BuiltRequest = { method: string; url: string; headers: Record<string, string>; body?: string };
export type BuildProblem = { field: string; code: 'REQUIRED' | 'INVALID_VALUE' | 'INVALID_JSON' };
export function buildRequest(e: Endpoint, input: RunInput): { request: BuiltRequest; problems?: undefined } | { problems: BuildProblem[]; request?: undefined } {
  const problems: BuildProblem[] = [];
  // A path value is one segment: encoded whole, and never "." or ".." (the address sent must be the one shown).
  const path = e.path.replace(/:(\w+)/g, (_, name: string) => {
    const v = (input.params[name] ?? '').trim();
    if (!v) { problems.push({ field: name, code: 'REQUIRED' }); return `:${name}`; }
    if (v === '.' || v === '..' || v.length > 200 || /[\u0000-\u001f\u007f]/.test(v)) { problems.push({ field: name, code: 'INVALID_VALUE' }); return `:${name}`; }
    return encodeURIComponent(v);
  });
  const query = new URLSearchParams();
  for (const q of queryFields(e)) {
    const v = (input.query[q.name] ?? '').trim();
    if (v) query.set(q.name, v); else if (q.required) problems.push({ field: q.name, code: 'REQUIRED' });
  }
  // Says where the request comes from: the API counts such requests against the per-minute limit of an API token.
  const headers: Record<string, string> = { 'X-Lightning-Try': '1' };
  let body: string | undefined;
  if (takesBody(e) && input.body.trim()) {
    try { body = JSON.stringify(JSON.parse(input.body)); headers['Content-Type'] = 'application/json'; }
    catch { problems.push({ field: 'body', code: 'INVALID_JSON' }); }
  }
  // The header every change needs (the API refuses a cross-site form without it), and the key that makes a repeat safe.
  if (e.method !== 'GET') headers['X-Lightning-CSRF'] = '1';
  if (e.idempotencyKey) {
    if (/^[\w-]{8,100}$/.test(input.idempotencyKey ?? '')) headers['Idempotency-Key'] = input.idempotencyKey!;
    else problems.push({ field: 'Idempotency-Key', code: 'REQUIRED' });
  }
  if (problems.length) return { problems };
  const qs = query.toString();
  return { request: { method: e.method, url: `/api${path}${qs ? `?${qs}` : ''}`, headers, ...(body !== undefined && { body }) } };
}
// The request as text, the way it is shown before sending. The session cookie is the browser's own and is never read.
export function previewRequest(r: BuiltRequest, cookieNote: string) {
  return [`${r.method} ${r.url}`, ...Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`), `Cookie: ${cookieNote}`,
    ...(r.body !== undefined ? ['', JSON.stringify(JSON.parse(r.body), null, 2)] : [])].join('\n');
}

// An answer is shown without what looks like a secret: text under a name that says so (password, secret, token, key,
// cookie...) and text shaped like one wherever it stands (an API token, a signing secret, a private key). Numbers,
// true/false and empty values stay, so "passwordSet: true" still reads. hidden: how many values were replaced.
const secretName = /pass(word|phrase)|secret|token|api_?key|private_?key|authori[sz]ation|cookie|credential|backup_?codes|totp|otpauth|recovery/i;
const secretShape = /^(lvm_[\w-]{20,}|whsec_\w{8,}|(sk|rk|pk)_(live|test)_\w{8,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})$|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
export const hiddenMark = '•••••• (hidden)';
export function maskSecrets(value: unknown): { value: unknown; hidden: number } {
  let hidden = 0;
  const hide = () => { hidden++; return hiddenMark; };
  const walk = (v: unknown, named: boolean, depth: number): unknown => {
    if (typeof v === 'string') return v && (named || secretShape.test(v)) ? hide() : v;
    if (!v || typeof v !== 'object' || depth > 40) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, named, depth + 1));
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, named || secretName.test(k), depth + 1)]));
  };
  return { value: walk(value, false, 0), hidden };
}
// The body of an answer as it is shown: JSON pretty-printed with secrets hidden, and only when all of it was read
// and it parses (a cut-off or broken one could not be searched for them by name, so it is not shown at all); plain
// text with secret-shaped words replaced; anything else by its type alone.
export const shownBodyLimit = 200_000;
export function shownBody(contentType: string, text: string, truncated: boolean): { kind: 'json' | 'text' | 'empty' | 'other'; text: string; hidden: number } {
  if (!text) return { kind: 'empty', text: '', hidden: 0 };
  if (/json/i.test(contentType)) {
    if (truncated) return { kind: 'other', text: '', hidden: 0 };
    try { const m = maskSecrets(JSON.parse(text)); return { kind: 'json', text: JSON.stringify(m.value, null, 2), hidden: m.hidden }; } catch { return { kind: 'other', text: '', hidden: 0 }; }
  }
  if (!/^text\/(plain|csv)/i.test(contentType)) return { kind: 'other', text: '', hidden: 0 };
  let hidden = 0;
  const masked = text.replace(/lvm_[\w-]{20,}|whsec_\w{8,}|(?:sk|rk|pk)_(?:live|test)_\w{8,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g, () => { hidden++; return hiddenMark; });
  return { kind: 'text', text: masked, hidden };
}

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
