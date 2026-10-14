/** Impact mode's baseline `ignore` for a base config of the repository: links, submodules and untracked files. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { loadConfig, prepareImpact } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** Files by path: text, or `{ link }` for a symbolic link to `link`. */
type Tree = Record<string, string | { link: string }>;

function put(root: string, tree: Tree): void {
  for (const [path, value] of Object.entries(tree)) {
    const full = join(root, path);
    rmSync(full, { force: true });
    mkdirSync(dirname(full), { recursive: true });
    if (typeof value === 'string') writeFileSync(full, value);
    else symlinkSync(value.link, full);
  }
}

function init(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

function commit(dir: string, message: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

const IGNORES_B = 'ignore: ["b/**"]\n';
const NOTHING = 'ignore: []\n';
const OF_REPOSITORY =
  "the base config is a file of this repository, so the baseline's impact settings leave it out";

/**
 * A repository with `base` committed on main and `head` on top of it on the checked-out branch, and an embedded
 * repository `.org` holding each of `org` in turn: main records it at `org[at[0]]` (or at a commit the clone lacks),
 * the branch at `org[at[1]]`.
 */
function repo(base: Tree, head: Tree, org: Tree[] = [], at: [number | 'missing', number] = [0, 0]): string {
  const top = mkdtempSync(join(tmpdir(), 'flowpact-impact-run-'));
  init(top);
  put(top, { '.github/flowpact/flowpact.config.yml': 'impact:\n  publish: ["*/action.yml"]\n', ...base });
  const sub = join(top, '.org');
  if (org.length) init(sub);
  const versions = org.map((files, i) => {
    put(sub, files);
    return commit(sub, `v${i + 1}`);
  });
  const checkout = (i: number | 'missing') => {
    if (versions.length && i !== 'missing') git(sub, 'checkout', '-q', versions[i]!);
  };
  checkout(at[0]);
  git(top, 'add', '-A');
  if (at[0] === 'missing') git(top, 'update-index', '--cacheinfo', `160000,${'1'.repeat(40)},.org`);
  git(top, 'commit', '-q', '-m', 'base');
  git(top, 'checkout', '-q', '-b', 'change');
  checkout(at[1]);
  put(top, head);
  commit(top, 'change');
  return top;
}

/** What `prepareImpact` pairs with the pull request's `ignore` when the run passes the base config `file`. */
function baselineOf(root: string, file: string) {
  const baseConfigFile = join(root, file);
  const loaded = loadConfig(root, undefined, { base: baseConfigFile });
  const prepared = prepareImpact(root, loaded.config, {
    base: 'main',
    title: 'fix: x',
    baseConfig: loaded.base!.data,
    baseConfigFile,
  });
  if ('skip' in prepared) throw new Error(prepared.skip);
  const { ignore, ignoreAfterMerge, ignoreUnread } = prepared.options;
  return { ignore, ignoreAfterMerge, ignoreUnread, notes: prepared.notes };
}

describe('a base config reached through a symbolic link', () => {
  const CONFIGS = { '.github/org/strict.yml': NOTHING, '.github/org/loose.yml': IGNORES_B };

  it('reads the config the baseline points a tracked link at', () => {
    // Before: the working tree's target (loose.yml), as the baseline has it, so b was left out on both sides.
    const moved = baselineOf(
      repo(
        { ...CONFIGS, '.github/base.yml': { link: 'org/strict.yml' } },
        { '.github/base.yml': { link: 'org/loose.yml' } },
      ),
      '.github/base.yml',
    );
    expect(moved).toMatchObject({ ignore: [], notes: [OF_REPOSITORY] });
    expect(moved.ignoreAfterMerge).toBeUndefined();
    const kept = repo({ ...CONFIGS, '.github/base.yml': { link: 'org/loose.yml' } }, {});
    expect(baselineOf(kept, '.github/base.yml').ignore).toEqual(['b/**']);
    // A linked directory on the way, and a link to a link.
    const dir = repo(
      {
        '.github/strict/base.yml': NOTHING,
        '.github/loose/base.yml': IGNORES_B,
        '.github/org': { link: 'strict' },
      },
      { '.github/org': { link: 'loose' } },
    );
    expect(baselineOf(dir, '.github/org/base.yml').ignore).toEqual([]);
    const chain = repo(
      {
        ...CONFIGS,
        '.github/base.yml': { link: 'org/current.yml' },
        '.github/org/current.yml': { link: 'strict.yml' },
      },
      { '.github/org/current.yml': { link: './loose.yml' } },
    );
    expect(baselineOf(chain, '.github/base.yml').ignore).toEqual([]);
  });

  it('reads the directory the baseline has where the pull request puts a link to the top of the repository', () => {
    // The pull request turns .github/org into a link to the top, whose base.yml ignores b. Before: the path was taken
    // from that link (base.yml), so the baseline's base.yml at the top counted, and b was left out on both sides.
    const root = repo({ '.github/org/base.yml': NOTHING, 'base.yml': IGNORES_B }, {});
    git(root, 'rm', '-rq', '.github/org');
    put(root, { '.github/org': { link: '..' } });
    commit(root, 'link');
    expect(baselineOf(root, '.github/org/base.yml')).toMatchObject({ ignore: [], notes: [OF_REPOSITORY] });
    // A link to the top that both sides have counts as each has it: the same base.yml.
    const kept = repo({ '.github/org': { link: '..' }, 'base.yml': IGNORES_B }, {});
    expect(baselineOf(kept, '.github/org/base.yml').ignore).toEqual(['b/**']);
  });

  it('counts a link that loops in the baseline as no base config there', () => {
    const root = repo(
      { ...CONFIGS, '.github/base.yml': { link: 'base.yml' } },
      { '.github/base.yml': { link: 'org/loose.yml' } },
    );
    expect(baselineOf(root, '.github/base.yml')).toMatchObject({ ignore: [], notes: [OF_REPOSITORY] });
  });

  it('follows a link no commit tracks to the tracked config, read as the baseline has it', () => {
    // Links made by an earlier step: relative, and absolute.
    const root = repo({ '.github/org/strict.yml': NOTHING }, { '.github/org/strict.yml': IGNORES_B });
    put(root, {
      '.base.yml': { link: '.github/org/strict.yml' },
      '.abs.yml': { link: join(root, '.github/org/strict.yml') },
    });
    expect(baselineOf(root, '.base.yml').ignore).toEqual([]);
    expect(baselineOf(root, '.abs.yml').ignore).toEqual([]);
  });

  it('reads a config a link points at outside the repository, or one no commit tracks, as the baseline points it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'flowpact-impact-org-'));
    put(outside, { 'strict.yml': NOTHING, 'loose.yml': IGNORES_B });
    const absolute = repo(
      { '.github/base.yml': { link: join(outside, 'strict.yml') } },
      { '.github/base.yml': { link: join(outside, 'loose.yml') } },
    );
    expect(baselineOf(absolute, '.github/base.yml')).toMatchObject({ ignore: [], notes: [OF_REPOSITORY] });
    // Up out of the repository, relative to the link.
    const up = (to: string) => relative(join(absolute, '.github'), join(outside, to));
    const relativeLink = repo(
      { '.github/base.yml': { link: up('strict.yml') } },
      { '.github/base.yml': { link: up('loose.yml') } },
    );
    expect(baselineOf(relativeLink, '.github/base.yml').ignore).toEqual([]);
    // The same file on both sides counts on both sides, as a file outside the repository does.
    const kept = repo({ '.github/base.yml': { link: join(outside, 'loose.yml') } }, {});
    expect(baselineOf(kept, '.github/base.yml')).toMatchObject({ ignore: ['b/**'], notes: [] });
    // Configs in a gitignored directory.
    const ignored = repo(
      { '.gitignore': '.org/\n', '.github/base.yml': { link: '../.org/strict.yml' } },
      { '.github/base.yml': { link: '../.org/loose.yml' } },
    );
    put(ignored, { '.org/strict.yml': NOTHING, '.org/loose.yml': IGNORES_B });
    expect(baselineOf(ignored, '.github/base.yml')).toMatchObject({ ignore: [], notes: [OF_REPOSITORY] });
  });

  it('takes a link or a path written in another case for the tracked one, where the file system ignores case', (ctx) => {
    const root = repo(
      { ...CONFIGS, '.github/base.yml': { link: 'ORG/STRICT.yml' } },
      { '.github/base.yml': { link: 'ORG/LOOSE.yml' } },
    );
    if (!existsSync(join(root, '.GITHUB/ORG/LOOSE.yml'))) ctx.skip();
    expect(baselineOf(root, '.github/base.yml').ignore).toEqual([]);
    expect(baselineOf(root, '.GITHUB/BASE.yml').ignore).toEqual([]);
  });

  it('takes a path in another case for the tracked one where the file system ignores case, though git says it does not', (ctx) => {
    // core.ignorecase=false, as set to catch case-only renames on macOS. Before: ORG was looked up in the commit as
    // written and missed, so the file it reaches, which the pull request edits, counted on both sides and left b out.
    const root = repo(
      { '.github/org/base.yml': NOTHING, '.github/base.yml': { link: 'ORG/base.yml' } },
      { '.github/org/base.yml': IGNORES_B },
    );
    if (!existsSync(join(root, '.GITHUB/ORG/BASE.yml'))) ctx.skip();
    git(root, 'config', 'core.ignorecase', 'false');
    for (const path of ['.github/base.yml', '.github/ORG/base.yml', '.github/org/BASE.yml'])
      expect(baselineOf(root, path)).toMatchObject({ ignore: [], notes: [OF_REPOSITORY] });
  });
});

describe('a base config the baseline lacks or no commit tracks', () => {
  it("does not count the pull request's new base config on the baseline's side", () => {
    const root = repo({}, { '.github/org-base.yml': IGNORES_B });
    expect(baselineOf(root, '.github/org-base.yml')).toMatchObject({ ignore: [], notes: [OF_REPOSITORY] });
  });

  it('uses one no commit tracks on both sides', () => {
    const root = repo({ '.gitignore': 'gen/\n' }, {});
    put(root, { 'gen/base.yml': IGNORES_B });
    expect(baselineOf(root, 'gen/base.yml')).toMatchObject({ ignore: ['b/**'], notes: [] });
  });

  it('does not count one the pull request reaches through a link or submodule in place of a directory', () => {
    // The baseline has .github/org without base.yml; the pull request turns it into a link to .github/loose, whose
    // base.yml it makes ignore b. Taken for a file no commit tracks, it counted on both sides and left b out.
    const link = repo({ '.github/org/README': 'x\n', '.github/loose/base.yml': NOTHING }, {});
    rmSync(join(link, '.github/org'), { recursive: true });
    put(link, { '.github/org': { link: 'loose' }, '.github/loose/base.yml': IGNORES_B });
    commit(link, 'link');
    expect(baselineOf(link, '.github/org/base.yml')).toMatchObject({ ignore: [], notes: [OF_REPOSITORY] });
    // The same with a submodule in place of the baseline's .org.
    const sub = repo({ '.org/README': 'x\n' }, {});
    git(sub, 'rm', '-rq', '.org');
    init(join(sub, '.org'));
    put(join(sub, '.org'), { 'base.yml': IGNORES_B });
    commit(join(sub, '.org'), 'v1');
    commit(sub, 'submodule');
    expect(baselineOf(sub, '.org/base.yml')).toMatchObject({
      ignore: [],
      ignoreAfterMerge: ['b/**'],
      notes: [OF_REPOSITORY],
    });
  });
});

describe('a base config within a submodule', () => {
  it('uses a file generated in the submodule that no commit of it tracks on both sides', () => {
    // Before: read at the submodule's commit, which lacks it, so the baseline's ignore lacked b.
    const root = repo({}, {}, [{ 'base.yml': NOTHING }]);
    put(root, { '.org/gen.yml': IGNORES_B });
    expect(baselineOf(root, '.org/gen.yml')).toMatchObject({ ignore: ['b/**'], notes: [] });
  });

  it('pairs it with the commit the pull request records, not one checked out in its place', () => {
    const versions = [{ 'base.yml': NOTHING }, { 'base.yml': IGNORES_B }];
    // Both record v1; the submodule is checked out at v2 (`git submodule update --remote`).
    const remote = repo({}, {}, versions, [0, 0]);
    git(join(remote, '.org'), 'checkout', '-q', 'main');
    expect(baselineOf(remote, '.org/base.yml')).toMatchObject({ ignore: [], ignoreAfterMerge: [] });
    // The pull request records v2.
    const moved = repo({}, {}, versions, [0, 1]);
    expect(baselineOf(moved, '.org/base.yml')).toMatchObject({ ignore: [], ignoreAfterMerge: ['b/**'] });
  });

  it('follows a link in the submodule back into the repository, as each side has it', () => {
    const root = repo({ '.github/org/strict.yml': NOTHING }, { '.github/org/strict.yml': IGNORES_B }, [
      { 'base.yml': { link: '../.github/org/strict.yml' } },
    ]);
    const r = baselineOf(root, '.org/base.yml');
    expect(r.ignore).toEqual([]);
    // The file is the repository's own, which the working tree has as the pull request does.
    expect(r.ignoreAfterMerge).toBeUndefined();
  });

  it('names the submodule, and leaves nothing out for it, when the clone lacks the commit the pull request records', () => {
    // The baseline records v1, which ignores b, and the submodule is checked out there; the pull request records a
    // commit the clone lacks. Before: the working tree's ignore stood in for it, so b was left out with no word.
    const root = repo({}, {}, [{ 'base.yml': IGNORES_B }]);
    git(root, 'update-index', '--cacheinfo', `160000,${'2'.repeat(40)},.org`);
    git(root, 'commit', '-q', '-m', 'record a commit the clone lacks');
    expect(baselineOf(root, '.org/base.yml')).toMatchObject({
      ignore: ['b/**'],
      ignoreAfterMerge: [],
      notes: [
        OF_REPOSITORY,
        "the pull request's version of the base config .org/base.yml is in the submodule .org at 2222222, which this clone lacks, so impact mode reads no ignore from it for the pull request",
      ],
    });
  });

  it('leaves nothing out for the commit the pull request records, when it lacks the config checked out in its place', () => {
    // Both record v1, which lacks base.yml; the submodule is checked out at v2, whose base.yml ignores b. Before: v2's
    // ignore stood in for the pull request's, so its edit to ignore was noted though the pull request changes nothing.
    const root = repo({}, {}, [{ README: 'x\n' }, { 'base.yml': IGNORES_B }]);
    git(join(root, '.org'), 'checkout', '-q', 'main');
    const v1 = git(join(root, '.org'), 'rev-parse', '--short=7', 'HEAD~1');
    expect(baselineOf(root, '.org/base.yml')).toMatchObject({
      ignore: [],
      ignoreAfterMerge: [],
      notes: [
        OF_REPOSITORY,
        `the pull request's commit of the submodule .org at ${v1} has no base config .org/base.yml, so impact mode reads no ignore from it for the pull request`,
      ],
    });
  });

  it("names the submodule when the clone lacks the baseline's commit of it", () => {
    const root = repo({}, {}, [{ 'base.yml': IGNORES_B }], ['missing', 0]);
    expect(baselineOf(root, '.org/base.yml')).toMatchObject({
      ignore: [],
      ignoreUnread: '.org/base.yml',
      notes: [
        OF_REPOSITORY,
        "the baseline's version of the base config .org/base.yml is in the submodule .org at 1111111, which this clone lacks, so impact mode reads no ignore from it for the baseline",
      ],
    });
  });
});
