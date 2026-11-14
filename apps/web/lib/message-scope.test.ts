import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { publicScope, setupScope } from './message-scope.ts';

const web = join(import.meta.dirname, '..');
const imports = /(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]/gs;
const uses = /(?:useTranslations|getTranslations)\(\s*(?:\{[^}]*namespace:\s*)?(['"]?)([A-Za-z0-9_]*)/g;

// Every translation namespace the given pages can reach through their local imports.
function reached(entries: string[]) {
  const seen = new Set<string>(); const names = new Set<string>(); const stack = entries.map((e) => normalize(join(web, e)));
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(imports)) {
      const base = normalize(join(dirname(file), m[1] ?? m[2] ?? m[3]));
      const hit = [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')].find((c) => /\.tsx?$/.test(c) && existsSync(c));
      if (hit) stack.push(hit);
    }
    for (const m of src.matchAll(uses)) {
      assert.ok(m[1] && m[2], `${file}: translations without a fixed namespace cannot be scoped`);
      names.add(m[2]);
    }
  }
  return names;
}
const pages = (group: string) => readdirSync(join(web, 'app', group), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `app/${group}/${d.name}/page.tsx`);

test('the sign-in pages and the status page get every namespace they use', () => {
  const used = reached(['app/layout.tsx', 'app/providers.tsx', 'app/(auth)/layout.tsx', ...pages('(auth)'), 'app/status/page.tsx']);
  const missing = [...used].filter((n) => !(publicScope as readonly string[]).includes(n));
  assert.deepEqual(missing, [], 'add these to publicScope in lib/message-scope.ts');
});

test('the setup wizard gets every namespace it uses', () => {
  const used = reached(['app/(setup)/layout.tsx', 'app/(setup)/setup/page.tsx']);
  const missing = [...used].filter((n) => !(setupScope as readonly string[]).includes(n));
  assert.deepEqual(missing, [], 'add these to setupScope in lib/message-scope.ts');
});
