// Fails when a locale misses a key, has an empty text, uses different {placeholders},
// or when the API emits an error or field code that has no translation.
import { readdirSync, readFileSync, existsSync } from 'node:fs';

const dir = new URL('../messages/', import.meta.url);
const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) =>
  typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]);
// Placeholder names only ({name} or {name, plural ...}); the text inside plural branches differs per language.
const args = (text) => [...new Set([...text.matchAll(/(?<!(?:zero|one|two|few|many|other|=\d+)\s*)\{(\w+)\s*[,}]/g)].map((m) => m[1]))].sort().join(',');
const locales = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => [f.slice(0, -5), new Map(flatten(JSON.parse(readFileSync(new URL(f, dir), 'utf8'))))]));

const problems = [];
const reference = locales.en;
for (const [locale, messages] of Object.entries(locales)) {
  for (const key of reference.keys()) if (!messages.has(key)) problems.push(`${locale}: missing ${key}`);
  for (const [key, text] of messages) {
    if (!reference.has(key)) problems.push(`${locale}: extra ${key}`);
    if (typeof text !== 'string' || !text.trim()) problems.push(`${locale}: empty ${key}`);
    // In ICU messages an apostrophe before "{" starts an escape, so '{name}' prints the literal text.
    else if (/'\{/.test(text)) problems.push(`${locale}: ${key} has '{ which ICU treats as an escape; use “{x}”`);
    else if (reference.has(key) && args(text) !== args(reference.get(key))) problems.push(`${locale}: placeholders differ in ${key}`);
  }
}

const apiSrc = new URL('../../api/src/', import.meta.url);
if (existsSync(apiSrc)) {
  for (const file of readdirSync(apiSrc, { recursive: true }).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(new URL(file.replaceAll('\\', '/'), apiSrc), 'utf8');
    if (file.endsWith('payment-providers.ts')) continue; // provider request bodies (currency_code: 'TRY' …), not API codes
    // Check result codes: the closed list in checks.ts.
    for (const [, list] of source.matchAll(/checkCodes = \[([^\]]+)\]/g)) {
      for (const [, code] of list.matchAll(/'([A-Z_]+)'/g)) {
        if (!reference.has(`Setup.checkCodes.${code}`)) problems.push(`api: check code ${code} has no Setup.checkCodes.${code} translation`);
      }
    }
    // Error codes: apiError(status, 'CODE', ...) and literal { code: 'CODE' } bodies (check results excluded).
    for (const [, code] of source.matchAll(/(?:apiError\(\s*\d+,\s*|(?<!ok: \w+, )code: )'([A-Z_]+)'/g)) {
      if (!reference.has(`errors.${code}`)) problems.push(`api: error code ${code} has no errors.${code} translation`);
    }
    // Field codes: fields.x / errors.x / fields[x] = 'CODE' and { x: 'CODE' } passed as apiError fields.
    for (const [, code] of source.matchAll(/(?:(?:fields|errors)(?:\.\w+|\[\w+\]) = |\{ (?!code:|method:|ContentType:)\w+: )'([A-Z_]+)'/g)) { // fetch({ method: 'POST' }) and mail { ContentType: 'HTML' } are not field codes
      if (!reference.has(`fieldErrors.${code}`)) problems.push(`api: field code ${code} has no fieldErrors.${code} translation`);
    }
  }
}

// The Go VMware adapter's failure codes reach the UI through the API unchanged.
const goSrc = new URL('../../../services/vmware/', import.meta.url);
if (existsSync(goSrc)) {
  for (const file of readdirSync(goSrc).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))) {
    for (const [, code] of readFileSync(new URL(file, goSrc), 'utf8').matchAll(/Code: "([A-Z_]+)"/g)) {
      if (!reference.has(`errors.${code}`)) problems.push(`vmware: error code ${code} has no errors.${code} translation`);
    }
  }
}

// So do the Node adapters' (Proxmox, XCP-ng, oVirt, Hyper-V, libvirt, Incus): new Failure('CODE') in their modules,
// Fail 'CODE' in the PowerShell and fail / bad CODE "..." in the shell they run on a host. A warning code is shown on
// the connection page (discovery: Vmware.warning) or with an operation (a clone's: errors).
const services = new URL('../../../services/', import.meta.url);
if (existsSync(services)) {
  for (const svc of readdirSync(services, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const dir = new URL(`${svc}/`, services);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      for (const [, a, b, c] of source.matchAll(/new Failure\('([A-Z][A-Z0-9_]+)'|\bFail '([A-Z][A-Z0-9_]+)'|\b(?:fail|bad) ([A-Z][A-Z0-9_]+) "/g)) {
        const code = a ?? b ?? c;
        if (!reference.has(`errors.${code}`)) problems.push(`${svc}: error code ${code} has no errors.${code} translation`);
      }
      for (const [, list] of source.matchAll(/warnings(?:\.push\(|: [^[\n]*\[)([^\])]*)/g)) {
        for (const [, code] of list.matchAll(/'([A-Z][A-Z0-9_]+)'/g)) {
          if (!reference.has(`Vmware.warning.${code}`) && !reference.has(`errors.${code}`)) problems.push(`${svc}: warning ${code} has no Vmware.warning.${code} (or errors.${code}) translation`);
        }
      }
    }
  }
}

// Worker operation error codes are shown on servers and in the admin operations list.
const workerSrc = new URL('../../worker/operations.mjs', import.meta.url);
if (existsSync(workerSrc)) {
  for (const [, code] of readFileSync(workerSrc, 'utf8').matchAll(/new OperationError\('([A-Z_]+)'/g)) {
    if (!reference.has(`errors.${code}`)) problems.push(`worker: error code ${code} has no errors.${code} translation`);
  }
}

// Console gateway close reasons reach the console page.
const consoleSrc = new URL('../../../services/console/', import.meta.url);
if (existsSync(consoleSrc)) {
  for (const file of readdirSync(consoleSrc).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))) {
    for (const [, code] of readFileSync(new URL(file, consoleSrc), 'utf8').matchAll(/"(CONSOLE_[A-Z_]+)"/g)) {
      if (code !== 'CONSOLE_ALLOW_NETWORKS' && code !== 'CONSOLE_DENY_NETWORKS' && code !== 'CONSOLE_ALLOWED_ORIGINS' && !code.startsWith('CONSOLE_MAX_')
        && !reference.has(`Console.reason.${code}`)) problems.push(`console: close reason ${code} has no Console.reason.${code} translation`);
    }
  }
}

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`messages ok: ${Object.keys(locales).join(', ')} (${reference.size} keys)`);
