#!/usr/bin/env node
// Keeps the version references in the docs and READMEs on the current release line, from release-please's manifest:
// - `<repository>@v0.3`: the action's floating tag (`v0.<minor>` before 1.0, `v<major>` from 1.0);
// - `<repository>@v0.3.2`: an exact pin of the action;
//   `<repository>` is the one in packages/lint/src/location.json; references through a previous repository
//   (scripts/previous-locations.json, after a move) are rewritten to it;
// - `flowpact@0.3`: an npm range for the CLI (`0.<minor>` before 1.0, `<major>` from 1.0);
// - `FLOWPACT_VERSION: 0.3.2`: the exact version a vendored-CLI example downloads;
// - the version in output samples: the banner (`flowpact v0.3.2 · config schema v1`) and the JSON report's `meta`,
//   also in the terminal screenshots (apps/docs/public/screenshots/*.svg).
// The release workflow runs it on the release pull request; `--check` lists stale references and exits 1.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = 'apps/docs/content/docs';
const SHOTS = 'apps/docs/public/screenshots';
/** Width of a character in the terminal screenshots (scripts/ansi-svg.ts). */
const CHAR_WIDTH = 8.4;

export const FILES = [
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'packages/cli/README.md',
  ...readdirSync(join(ROOT, DOCS), { recursive: true })
    .map((f) => String(f).replaceAll('\\', '/'))
    // In the sidebar's group folders too; not the rule pages, which are generated, nor the upgrading notes, which name
    // the versions they are about.
    .filter((f) => f.endsWith('.mdx') && !f.startsWith('rules/') && !f.endsWith('upgrading.mdx'))
    .sort()
    .map((f) => `${DOCS}/${f}`),
  ...readdirSync(join(ROOT, SHOTS))
    .filter((f) => f.endsWith('.svg'))
    .map((f) => `${SHOTS}/${f}`),
];

/** Where flowpact lives (packages/lint/src/location.json) and the repositories it lived at before. */
export const LOCATION = {
  repository: JSON.parse(readFileSync(join(ROOT, 'packages/lint/src/location.json'), 'utf8')).repository,
  previousRepositories: JSON.parse(readFileSync(join(ROOT, 'scripts/previous-locations.json'), 'utf8'))
    .repositories,
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function currentVersion() {
  return JSON.parse(readFileSync(join(ROOT, '.release-please-manifest.json'), 'utf8'))['.'];
}

/** A release version, prereleases included (`1.0.0-rc.1`). */
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?`;

/** `text` with every version reference moved to `version`'s release line, and action references to `location`'s repository. */
export function syncRefs(text, version, location = LOCATION) {
  const [major, minor] = version.split('.').map(Number);
  const line = major >= 1 ? `${major}` : `0.${minor}`;
  const repo = location.repository;
  const repos = [repo, ...location.previousRepositories].map(escapeRegExp).join('|');
  return text
    .replace(
      new RegExp(String.raw`(?<![\w.-])(?:${repos})@v${VERSION}(?![\w.-])`, 'g'),
      `${repo}@v${version}`,
    )
    .replace(
      new RegExp(String.raw`(?<![\w.-])(?:${repos})@v\d+(?:\.\d+)?(?![\w.-])`, 'g'),
      `${repo}@v${line}`,
    )
    .replace(/(?<![\w/@.-])flowpact@\d+(?:\.\d+)?(?![\w.-])/g, `flowpact@${line}`)
    .replace(new RegExp(`(FLOWPACT_VERSION: )${VERSION}(?![\\w.-])`, 'g'), `$1${version}`)
    .replace(new RegExp(`(flowpact {1,2}v)${VERSION}(?= {1,2}(?:· )?config schema)`, 'g'), `$1${version}`)
    .replace(new RegExp(`("tool": "flowpact", "version": ")${VERSION}"`, 'g'), `$1${version}"`)
    .replace(/<text y="[\d.]+">.*?<\/text>/g, (svgLine) => syncSvgBanner(svgLine, version));
}

/**
 * The banner line of a terminal screenshot (scripts/ansi-svg.ts): one <tspan> per word at its column, so a version of
 * another length also moves the words after it.
 */
function syncSvgBanner(svgLine, version) {
  const banner = new RegExp(
    String.raw`(>flowpact</tspan><tspan x="[\d.]+" textLength=")[\d.]+("[^>]*>)v(${VERSION})(</tspan>)`,
  ).exec(svgLine);
  if (!banner) return svgLine;
  const [whole, before, attrs, old, close] = banner;
  const shift = (version.length - old.length) * CHAR_WIDTH;
  const width = ((version.length + 1) * CHAR_WIDTH).toFixed(1);
  const rest = svgLine
    .slice(banner.index + whole.length)
    .replace(/ x="([\d.]+)"/g, (_, x) => ` x="${(Number(x) + shift).toFixed(1)}"`);
  return `${svgLine.slice(0, banner.index)}${before}${width}${attrs}v${version}${close}${rest}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const version = currentVersion();
  const stale = [];
  for (const file of FILES) {
    const before = readFileSync(join(ROOT, file), 'utf8');
    const after = syncRefs(before, version);
    if (after === before) continue;
    stale.push(file);
    if (!check) writeFileSync(join(ROOT, file), after);
  }
  if (check && stale.length) {
    console.error(`Version references are not on ${version}'s release line: ${stale.join(', ')}`);
    console.error('Run `node scripts/sync-version-refs.mjs`.');
    process.exit(1);
  }
  if (!check) console.log(stale.length ? `updated: ${stale.join(', ')}` : 'up to date');
}
