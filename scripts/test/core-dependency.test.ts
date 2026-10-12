/**
 * @ciatlas/core, the workflow model, comes from its own repository as a git dependency on a release tag
 * (CONTRIBUTING.md, "The workflow model"). What reaches main must name a release, the same one everywhere.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const manifests = [
  'package.json',
  ...readdirSync(join(root, 'packages'))
    .map((p) => `packages/${p}/package.json`)
    .filter((file) => existsSync(join(root, file))),
];

/** Every manifest that depends on @ciatlas/core, with the specifier it uses. */
function specifiers(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const file of manifests) {
    const pkg = JSON.parse(read(file)) as Record<string, Record<string, string> | undefined>;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const spec = pkg[section]?.['@ciatlas/core'];
      if (spec !== undefined) found[`${file} ${section}`] = spec;
    }
  }
  return found;
}

describe('@ciatlas/core', () => {
  it('is a release tag of ciatlas/core, the same in every package', () => {
    const specs = specifiers();
    expect(Object.keys(specs).length).toBeGreaterThan(0);
    const tags = new Set(Object.values(specs));
    expect([...tags]).toHaveLength(1);
    // A commit (`#<sha>`) or a branch is fine in a draft pull request, not on main.
    expect([...tags][0]).toMatch(/^github:ciatlas\/core#v\d+\.\d+\.\d+$/);
  });

  it('is not linked to a local checkout (pnpm link ../core writes an override)', () => {
    // An override is a key (`'@ciatlas/core': link:../core`); comments may name the package.
    expect(read('pnpm-workspace.yaml')).not.toMatch(/^\s*['"]?@ciatlas\/core['"]?\s*:/m);
    // Every package's entry in the lockfile resolves to the release's tarball on GitHub, pinned by commit.
    const lockfile = read('pnpm-lock.yaml');
    const versions = [
      ...lockfile.matchAll(/^ {6}'@ciatlas\/core':\n {8}specifier: [^\n]*\n {8}version: ([^\n]*)$/gm),
    ].map((m) => m[1]);
    expect(versions).toHaveLength(Object.keys(specifiers()).length);
    for (const version of versions)
      expect(version).toMatch(/^https:\/\/codeload\.github\.com\/ciatlas\/core\/tar\.gz\/[0-9a-f]{40}$/);
    // The commit it pins is the release's: its package.json has the tag's version. A lockfile edited by hand from a
    // draft's commit to the tag would keep the draft (release-please releases from a later commit).
    const tag = Object.values(specifiers())[0]!.split('#v')[1];
    for (const url of new Set(versions)) {
      const entry = lockfile.split(`\n  '@ciatlas/core@${url}':\n`)[1]?.split('\n\n')[0] ?? '';
      expect(entry, url).toMatch(new RegExp(`^ {4}version: ${tag!.replaceAll('.', '\\.')}$`, 'm'));
    }
  });
});
