/**
 * Verifies the exported docs site's links: every internal link and asset resolves to a file, and every `#anchor` to an
 * id on its page (on GitHub Pages a moved heading breaks the link without an error). Also every docs URL that something
 * else points at: the rule pages and command anchors the CLI prints, and the site URLs written in the repository's own
 * files (README, SECURITY, the packages, the fixtures). Run after `pnpm docs:build`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRegistry, DOCS_BASE_URL } from '@flowpact/lint';
import { anchorProblem, commandNames, htmlIds, siteLinksIn, underBase } from './docs-links';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'apps/docs/out');
const BASE = new URL(DOCS_BASE_URL).pathname.replace(/\/$/, ''); // e.g. /flowpact

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** The exported file a site path serves, or undefined when there is none. */
function fileOf(path: string): string | undefined {
  const rel = decodeURIComponent(path.slice(BASE.length).split(/[?#]/)[0] ?? '');
  const candidates = [rel, `${rel}/index.html`, `${rel}.html`, `${rel}index.html`];
  const found = candidates.find((c) => c && existsSync(join(OUT, c)) && statSync(join(OUT, c)).isFile());
  return found === undefined ? undefined : join(OUT, found);
}

const ids = new Map<string, Set<string>>();
/** The ids an exported page defines, read once. */
function idsOf(file: string): Set<string> {
  const known = ids.get(file);
  if (known) return known;
  const set = htmlIds(readFileSync(file, 'utf8'));
  ids.set(file, set);
  return set;
}

/** Why a link to a site path (with an optional `#anchor`) is broken, or undefined when it resolves. */
function brokenLink(target: string): string | undefined {
  if (!underBase(target, BASE)) return `missing base path ${BASE}`;
  const file = fileOf(target);
  if (!file) return 'no such page';
  return file.endsWith('.html') ? anchorProblem(target, idsOf(file)) : undefined;
}

/** The repository's tracked text files that can name the site, the exported site itself aside. */
function trackedFiles(): string[] {
  const all = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  return all.filter((f) => !f.startsWith('apps/docs/out/') && !/\.(png|jpe?g|gif|ico|vsix|woff2?)$/i.test(f));
}

/** Every site URL a tracked file names, with the file. */
function* inboundLinks(): Generator<{ from: string; path: string }> {
  for (const file of trackedFiles()) {
    const text = readText(join(ROOT, file));
    for (const path of siteLinksIn(text)) yield { from: file, path };
  }
}

/** A file's text; empty when it cannot be read (a submodule, a file deleted but not committed). */
function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The `cli#flowpact-<command>` anchors `flowpact <command> --help` prints. */
async function commandAnchors(): Promise<string[]> {
  const dir = join(ROOT, 'packages/cli/src/commands');
  const files = readdirSync(dir).filter((n) => n.endsWith('.ts'));
  const mods = await Promise.all(files.map((f) => import(pathToFileURL(join(dir, f)).href)));
  return mods.flatMap(commandNames).map((n) => `${BASE}/docs/cli#flowpact-${n}`);
}

if (!existsSync(OUT)) {
  console.error('apps/docs/out not found — run `pnpm docs:build` first');
  process.exit(2);
}

const broken: string[] = [];
let checked = 0;
const check = (from: string, target: string) => {
  checked++;
  const why = brokenLink(target);
  if (why) broken.push(`${from} → ${target} (${why})`);
};

for (const file of walk(OUT)) {
  if (!file.endsWith('.html')) continue;
  const html = readFileSync(file, 'utf8');
  const page = file.slice(OUT.length);
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = m[1]!.replace(/&amp;/g, '&');
    if (target.startsWith('#')) {
      checked++;
      const why = anchorProblem(target, idsOf(file));
      if (why) broken.push(`${page} → ${target} (${why})`);
    } else if (target.startsWith('/') && !target.startsWith('//')) check(page, target);
  }
}
const registry = createRegistry();
for (const rule of registry.all())
  check(`docs URL for ${rule.code}`, new URL(registry.docsUrl(rule)).pathname);
for (const anchor of await commandAnchors()) check('`flowpact <command> --help`', anchor);
for (const { from, path } of inboundLinks()) check(from, path);

if (broken.length) {
  console.error(`${broken.length} broken link(s):\n${[...new Set(broken)].map((b) => `  ${b}`).join('\n')}`);
  process.exit(1);
}
console.log(`checked ${checked} links and anchors: all resolve`);
