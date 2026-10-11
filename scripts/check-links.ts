/**
 * Verifies every internal link and asset in the exported docs site resolves to a file, and that every rule docs URL
 * the CLI prints exists. Run after `pnpm docs:build`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRegistry, DOCS_BASE_URL } from '@flowpact/lint';

const OUT = join(import.meta.dirname, '../apps/docs/out');
const BASE = new URL(DOCS_BASE_URL).pathname.replace(/\/$/, ''); // e.g. /flowpact

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const resolveTarget = (path: string) => {
  const rel = decodeURIComponent(path.slice(BASE.length).split(/[?#]/)[0] ?? '');
  const candidates = [rel, `${rel}/index.html`, `${rel}.html`, `${rel}index.html`];
  return candidates.some((c) => c && existsSync(join(OUT, c)) && statSync(join(OUT, c)).isFile());
};

if (!existsSync(OUT)) {
  console.error('apps/docs/out not found — run `pnpm docs:build` first');
  process.exit(2);
}

const broken: string[] = [];
let checked = 0;
for (const file of walk(OUT)) {
  if (!file.endsWith('.html')) continue;
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = m[1]!;
    if (!target.startsWith('/') || target.startsWith('//')) continue;
    checked++;
    if (!target.startsWith(`${BASE}/`) && target !== BASE) {
      broken.push(`${file.slice(OUT.length)} → ${target} (missing base path ${BASE})`);
    } else if (!resolveTarget(target)) {
      broken.push(`${file.slice(OUT.length)} → ${target}`);
    }
  }
}
for (const rule of createRegistry().all()) {
  const path = new URL(createRegistry().docsUrl(rule)).pathname;
  checked++;
  if (!resolveTarget(path)) broken.push(`docs URL for ${rule.code} → ${path}`);
}

if (broken.length) {
  console.error(`${broken.length} broken link(s):\n${[...new Set(broken)].map((b) => `  ${b}`).join('\n')}`);
  process.exit(1);
}
console.log(`checked ${checked} links: all resolve`);
