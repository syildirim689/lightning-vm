#!/usr/bin/env node
// Dependency audit for CI, run from a package directory (apps/web, apps/api, apps/worker):
//   node ../../scripts/audit.mjs
// It runs `npm audit --omit=dev --json` there and fails on every high or critical advisory, except the ones
// scripts/audit-allowlist.json excuses. An exception is narrow and cannot outlive its reason; it counts only
//   - for the package directory it names (scope),
//   - while the affected package is reached through nothing but the packages it names (via),
//   - until its expiry date (the last day it counts, UTC),
//   - while the registry has no release newer than the installed one that the advisory does not cover.
// What was excused is printed with its reason. An entry whose advisory is no longer reported fails as well, so a
// stale exception is removed and not left to excuse a later regression. No dependencies: node and npm only.
//
// For trying it by hand: --report FILE reads a saved `npm audit --json` instead of running npm, --today YYYY-MM-DD
// sets the date, --allowlist FILE another list. CI passes none of them.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const scope = relative(root, process.cwd()).split('\\').join('/');
const today = option('--today') ?? new Date().toISOString().slice(0, 10);
const blocking = ['high', 'critical'];
// On Windows npm is a script and needs a shell: one command line then, made of fixed words and a checked package name.
const npm = (list) => (process.platform === 'win32'
  ? spawnSync(`npm ${list.join(' ')}`, { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 })
  : spawnSync('npm', list, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

// ---- Versions and ranges, as far as advisories use them: comparators joined by spaces (all must hold) and "||" ----
const parse = (v) => {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) throw new Error(`not a version: "${v}"`);
  return { n: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? '' };
};
// A pre-release sorts before its release; two pre-releases of one release are not told apart (never offered as a fix).
const compare = (a, b) => {
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i] < b.n[i] ? -1 : 1;
  return a.pre === b.pre ? 0 : a.pre ? (b.pre ? 0 : -1) : 1;
};
function inRange(version, range) {
  const v = parse(version);
  return range.split('||').some((set) => set.trim().split(/\s+/).filter(Boolean).every((c) => {
    if (c === '*' || c === 'x') return true;
    const m = /^(<=|>=|<|>|=)?(.+)$/.exec(c);
    const d = compare(v, parse(m[2]));
    return m[1] === '<=' ? d <= 0 : m[1] === '>=' ? d >= 0 : m[1] === '<' ? d < 0 : m[1] === '>' ? d > 0 : d === 0;
  }));
}

// ---- The allowlist ----
function readAllowlist(file) {
  const list = JSON.parse(readFileSync(file, 'utf8')).advisories;
  if (!Array.isArray(list)) throw new Error('"advisories" must be a list');
  for (const e of list) {
    const where = `entry ${e?.id ?? JSON.stringify(e)}`;
    if (!/^GHSA(-[0-9a-z]{4}){3}$/.test(e?.id ?? '')) throw new Error(`${where}: "id" must be a GHSA id`);
    if (typeof e.package !== 'string' || !e.package) throw new Error(`${where}: "package" is missing`);
    if (typeof e.scope !== 'string' || !e.scope) throw new Error(`${where}: "scope" (the package directory, e.g. apps/web) is missing`);
    if (!Array.isArray(e.via) || !e.via.every((x) => typeof x === 'string' && x)) throw new Error(`${where}: "via" must list the packages it is reached through`);
    if (typeof e.reason !== 'string' || e.reason.trim().length < 40) throw new Error(`${where}: "reason" must say why the advisory is not reachable`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? '') || Number.isNaN(Date.parse(`${e.expires}T00:00:00Z`)) || new Date(`${e.expires}T00:00:00Z`).toISOString().slice(0, 10) !== e.expires) throw new Error(`${where}: "expires" must be a date, YYYY-MM-DD`);
  }
  return list;
}

// ---- The report ----
function readReport() {
  const file = option('--report');
  let text;
  if (file) text = readFileSync(file, 'utf8');
  else {
    const r = npm(['audit', '--omit=dev', '--json']);
    if (r.error) throw new Error(`npm did not start: ${r.error.message}`);
    text = r.stdout; // npm exits 1 when it found something: the report is read either way
    if (!text.trim()) throw new Error(`npm audit printed no report (exit ${r.status}): ${r.stderr.trim().slice(0, 400)}`);
  }
  const report = JSON.parse(text);
  if (report.error) throw new Error(`npm audit failed: ${report.error.code ?? ''} ${report.error.summary ?? JSON.stringify(report.error)}`);
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') throw new Error('npm audit: no "vulnerabilities" in the report');
  return report;
}
const ghsa = (url) => /GHSA(-[0-9a-z]{4}){3}/.exec(url ?? '')?.[0] ?? null;

// Every package that is vulnerable because of this one, all the way up to what package.json asks for.
function dependents(report, name) {
  const seen = new Set();
  const walk = (n) => { for (const e of report.vulnerabilities[n]?.effects ?? []) if (!seen.has(e)) { seen.add(e); walk(e); } };
  walk(name);
  return [...seen].sort();
}
function installed(report, name) {
  const out = [];
  for (const node of report.vulnerabilities[name]?.nodes ?? []) {
    const file = join(process.cwd(), node, 'package.json');
    if (existsSync(file)) try { out.push(parse(JSON.parse(readFileSync(file, 'utf8')).version)); } catch { /* unreadable: the stricter rule below applies */ }
  }
  return out;
}
// The newest release the advisory does not cover, when it is newer than what is installed (or, when that cannot be
// read, than every affected release). Answers its version, or null when there is none.
function fixedVersion(report, name, range) {
  if (!/^(@[a-z0-9~._-]+\/)?[a-z0-9~._-]+$/.test(name)) throw new Error(`not a package name: "${name}"`);
  const r = npm(['view', name, 'versions', '--json']);
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`could not ask the registry for the releases of ${name}: ${(r.stderr || '').trim().slice(0, 300)}`);
  const all = [JSON.parse(r.stdout)].flat().filter((v) => { try { return !parse(v).pre; } catch { return false; } });
  const affected = all.filter((v) => inRange(v, range)).map(parse);
  const have = installed(report, name);
  const floor = (have.length ? have : affected).reduce((a, b) => (a && compare(a, b) >= 0 ? a : b), null);
  const fixed = all.filter((v) => !inRange(v, range) && (!floor || compare(parse(v), floor) > 0));
  return fixed.length ? fixed.reduce((a, b) => (compare(parse(a), parse(b)) >= 0 ? a : b)) : null;
}

function main() {
  const allowlist = readAllowlist(option('--allowlist') ?? join(root, 'scripts', 'audit-allowlist.json'));
  const report = readReport();
  // One row per advisory and package; packages that are vulnerable only through another one are that one's dependents.
  const found = new Map();
  for (const [name, v] of Object.entries(report.vulnerabilities)) {
    for (const via of v.via ?? []) {
      if (typeof via !== 'object' || !via) continue;
      const id = ghsa(via.url) ?? `npm:${via.source}`;
      found.set(`${id} ${name}`, { id, name, severity: via.severity ?? v.severity, range: via.range ?? v.range ?? '*', title: via.title ?? '', url: via.url ?? '' });
    }
  }
  const counts = { low: 0, moderate: 0, high: 0, critical: 0, info: 0 };
  for (const a of found.values()) counts[a.severity] = (counts[a.severity] ?? 0) + 1;
  console.log(`audit ${scope || '.'} (${today}): ${found.size} advisories (critical ${counts.critical}, high ${counts.high}, moderate ${counts.moderate}, low ${counts.low})`);

  const failures = [];
  const used = new Set();
  for (const a of [...found.values()].filter((x) => blocking.includes(x.severity))) {
    const label = `${a.severity.toUpperCase()} ${a.id} ${a.name} ${a.range}: ${a.title}`;
    const entry = allowlist.find((e) => e.id === a.id && e.package === a.name && e.scope === scope);
    if (!entry) { failures.push(`${label}\n    not in scripts/audit-allowlist.json for ${scope}`); continue; }
    used.add(entry);
    if (today > entry.expires) { failures.push(`${label}\n    its exception ran out on ${entry.expires}: fix it, or look at it again and renew the entry`); continue; }
    if (report.vulnerabilities[a.name]?.isDirect) { failures.push(`${label}\n    ${a.name} is now a direct dependency: the exception covers it only through ${entry.via.join(', ')}`); continue; }
    const outside = dependents(report, a.name).filter((d) => !entry.via.includes(d));
    if (outside.length) { failures.push(`${label}\n    now also reached through ${outside.join(', ')}: the exception covers only ${entry.via.join(', ')}`); continue; }
    const fixed = fixedVersion(report, a.name, a.range);
    if (fixed) { failures.push(`${label}\n    ${a.name} ${fixed} is not affected: upgrade and remove the entry from scripts/audit-allowlist.json`); continue; }
    console.log(`  excused: ${label}\n    until ${entry.expires}, reached only through ${dependents(report, a.name).join(' <- ') || 'nothing'}; no unaffected release of ${a.name} exists\n    reason: ${entry.reason}`);
  }
  for (const e of allowlist) if (e.scope === scope && !used.has(e)) failures.push(`${e.id} ${e.package}\n    is in scripts/audit-allowlist.json for ${scope} but is no longer reported here: remove the entry`);

  if (failures.length) {
    console.error(`audit ${scope || '.'}: FAILED`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`audit ${scope || '.'}: ok (no high or critical advisory that is not excused)`);
}

try { main(); } catch (e) {
  // What cannot be checked is not passed.
  console.error(`audit ${scope || '.'}: FAILED\n  ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
