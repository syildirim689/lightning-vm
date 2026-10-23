// Fails when a locale misses a key, has an empty text, uses different {placeholders},
// or when the API emits an error code that has no translation.
import { readdirSync, readFileSync, existsSync } from 'node:fs';

const dir = new URL('../messages/', import.meta.url);
const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) =>
  typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]);
const args = (text) => [...text.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort().join(',');
const locales = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => [f.slice(0, -5), new Map(flatten(JSON.parse(readFileSync(new URL(f, dir), 'utf8'))))]));

const problems = [];
const reference = locales.en;
for (const [locale, messages] of Object.entries(locales)) {
  for (const key of reference.keys()) if (!messages.has(key)) problems.push(`${locale}: missing ${key}`);
  for (const [key, text] of messages) {
    if (!reference.has(key)) problems.push(`${locale}: extra ${key}`);
    if (typeof text !== 'string' || !text.trim()) problems.push(`${locale}: empty ${key}`);
    else if (reference.has(key) && args(text) !== args(reference.get(key))) problems.push(`${locale}: placeholders differ in ${key}`);
  }
}

const apiSrc = new URL('../../api/src/', import.meta.url);
if (existsSync(apiSrc)) {
  for (const file of readdirSync(apiSrc, { recursive: true }).filter((f) => f.endsWith('.ts'))) {
    for (const [, code] of readFileSync(new URL(file.replaceAll('\\', '/'), apiSrc), 'utf8').matchAll(/code: '([A-Z_]+)'/g)) {
      if (!reference.has(`errors.${code}`)) problems.push(`api: error code ${code} has no errors.${code} translation`);
    }
  }
}

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`messages ok: ${Object.keys(locales).join(', ')} (${reference.size} keys)`);
