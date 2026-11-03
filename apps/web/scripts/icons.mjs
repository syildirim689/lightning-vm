// Builds components/icons.json: only the Lucide icons the source uses (<I name="..."/>), so the icon
// component works offline and the browser never asks the Iconify API. --check fails when it is stale.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'components', 'icons.json');
const names = new Set();
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(f)) {
      const src = readFileSync(p, 'utf8');
      for (const m of src.matchAll(/<I\s+name="([a-z0-9-]+)"/g)) names.add(m[1]);
      // Conditional names: every quoted name inside name={...}.
      for (const m of src.matchAll(/<I\s+name=\{([^}]*)\}/g)) for (const q of m[1].matchAll(/'([a-z0-9-]+)'/g)) names.add(q[1]);
      // Lookup tables of icons: `icon: 'name'` fields and objects held in a const named ...icons / ...Icons.
      for (const m of src.matchAll(/\bicon: '([a-z0-9-]+)'/g)) names.add(m[1]);
      for (const m of src.matchAll(/const \w*[iI]cons\b[^=]*=\s*\{([^}]*)\}/g)) for (const q of m[1].matchAll(/'([a-z0-9-]+)'/g)) names.add(q[1]);
    }
  }
};
['app', 'components'].forEach((d) => walk(join(root, d)));
const lucide = JSON.parse(readFileSync(join(root, 'node_modules', '@iconify-json', 'lucide', 'icons.json'), 'utf8'));
const icons = {};
for (const n of [...names].sort()) {
  const icon = lucide.icons[n] ?? lucide.icons[lucide.aliases?.[n]?.parent];
  if (!icon) { console.error(`unknown lucide icon: ${n}`); process.exit(1); }
  icons[n] = icon;
}
const json = JSON.stringify({ prefix: 'lucide', width: lucide.width ?? 24, height: lucide.height ?? 24, icons }, null, 1) + '\n';
if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(out, 'utf8'); } catch { /* missing counts as stale */ }
  if (current !== json) { console.error('components/icons.json is stale: run npm run icons'); process.exit(1); }
  console.log(`icons ok (${names.size})`);
} else {
  writeFileSync(out, json);
  console.log(`wrote ${names.size} icons`);
}
