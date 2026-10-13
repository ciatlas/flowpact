/** `flowpact impact` and `--impact` on real git repositories (base commit, pull request head, release tags). */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/dist/index.js');

const flowpact = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execa('node', [BIN, ...args, '-q'], {
    cwd,
    reject: false,
    timeout: 45_000,
    extendEnv: false,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NO_COLOR: '1', ...env },
  });

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function write(root: string, files: Record<string, string>) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
}

const reusable = (name: string) =>
  `on:\n  workflow_call:\n    inputs:\n      node: { type: string, default: '22' }\njobs:\n  test:\n    name: ${name}\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n`;

/** A repository with `base` committed on main and `head` committed on a branch. */
function repo(base: Record<string, string>, head: Record<string, string>, sub = ''): string {
  const top = mkdtempSync(join(tmpdir(), 'flowpact-impact-'));
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.email', 't@example.com');
  git(top, 'config', 'user.name', 't');
  git(top, 'config', 'commit.gpgsign', 'false');
  git(top, 'config', 'tag.gpgsign', 'false');
  const root = join(top, sub);
  write(root, base);
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'base');
  git(top, 'checkout', '-q', '-b', 'change');
  write(root, head);
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'change');
  return root;
}

const WF = '.github/workflows/ci-reusable.yml';
const renamed = () => repo({ [WF]: reusable('Test') }, { [WF]: reusable('Unit tests') });

describe('flowpact impact', () => {
  it('fails an under-declared rename and passes a breaking title', async () => {
    const root = renamed();
    const fix = await flowpact(root, ['impact', '--base', 'main', '--title', 'fix: tidy the test job']);
    expect(fix.exitCode).toBe(1);
    expect(fix.stdout).toContain('FP810');
    expect(fix.stdout).toContain('check "… / Test" is now "… / Unit tests"');
    const bang = await flowpact(root, ['impact', '--base', 'main', '--title', 'fix!: rename the test check']);
    expect(bang.exitCode).toBe(0);
    expect((await flowpact(root, ['impact', '--base', 'main', '--expect', 'major'])).exitCode).toBe(0);
  });

  it('reports a conflicting label and writes the verdict as JSON', async () => {
    const root = renamed();
    const r = await flowpact(root, [
      'impact',
      '--base',
      'main',
      '--title',
      'fix: x',
      '--labels',
      'semver:major',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.findings.map((f: { code: string }) => f.code).sort()).toEqual(['FP810', 'FP811']);
    expect(report.impact).toMatchObject({
      required: 'major',
      ok: false,
      declared: { kind: 'title', level: 'patch' },
    });
  });

  it('is a usage error for an unknown base and on pull_request_target', async () => {
    const root = renamed();
    expect((await flowpact(root, ['impact', '--base', 'no-such-ref'])).exitCode).toBe(2);
    const event = join(root, 'event.json');
    writeFileSync(event, JSON.stringify({ pull_request: { title: 'fix: x', base: { sha: 'main' } } }));
    const r = await flowpact(root, ['impact'], {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request_target',
      GITHUB_EVENT_PATH: event,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('pull_request_target');
  });

  it('reads the title and labels from the pull request event', async () => {
    const root = renamed();
    const event = join(root, 'event.json');
    writeFileSync(
      event,
      JSON.stringify({ pull_request: { title: 'feat!: unit tests', labels: [], base: { sha: 'main' } } }),
    );
    const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event };
    expect((await flowpact(root, ['impact'], env)).exitCode).toBe(0);
  });

  it('checks a release pull request against the last release tag', async () => {
    const base = {
      [WF]: reusable('Test'),
      '.release-please-manifest.json': '{ ".": "0.1.0" }\n',
      'release-please-config.json': '{ "bump-minor-pre-major": true }\n',
    };
    const root = repo(base, { [WF]: reusable('Unit tests') });
    git(root, 'checkout', '-q', 'main');
    git(root, 'tag', 'v0.1.0');
    git(root, 'checkout', '-q', 'change');
    // The release branch: only the version changes on top of what was merged since v0.1.0.
    git(root, 'checkout', '-q', '-b', 'release');
    const bump = (v: string) => {
      write(root, { '.release-please-manifest.json': `{ ".": "${v}" }\n` });
      git(root, 'commit', '-q', '-am', `release ${v}`);
    };
    bump('0.1.1');
    const patch = await flowpact(root, [
      'impact',
      '--base',
      'change',
      '--title',
      'chore(main): release 0.1.1',
    ]);
    expect(patch.exitCode).toBe(1);
    expect(patch.stdout).toContain('FP810');
    bump('0.2.0');
    const minor = await flowpact(root, [
      'impact',
      '--base',
      'change',
      '--title',
      'chore(main): release 0.2.0',
      '--format',
      'json',
    ]);
    expect(minor.exitCode).toBe(0);
    expect(JSON.parse(minor.stdout).impact).toMatchObject({
      baseline: { kind: 'release', ref: 'v0.1.0' },
      declared: { kind: 'version', level: 'major' },
      required: 'major',
      ok: true,
    });
  });

  it('works for a project in a subdirectory of the git repository', async () => {
    const root = repo({ [WF]: reusable('Test') }, { [WF]: reusable('Unit tests') }, 'services/api');
    const r = await flowpact(root, ['impact', '--base', 'main', '--title', 'fix: x']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('FP810');
  });

  it('runs with lint via --impact', async () => {
    const root = renamed();
    const r = await flowpact(root, ['lint', '--impact', '--base', 'main', '--title', 'fix: x']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('FP810');
  });
});

describe('flowpact impact baselines and policy', () => {
  const ci = (env: Record<string, string>, root: string, payload: unknown) => {
    const event = join(root, '..', `event-${Object.keys(env).length}.json`);
    writeFileSync(event, JSON.stringify(payload));
    return { GITHUB_ACTIONS: 'true', GITHUB_EVENT_PATH: event, ...env };
  };
  const head = (root: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  const parent = (root: string) =>
    execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: root }).toString().trim();

  it('compares a push with the commit before it, and skips a new branch', async () => {
    const root = renamed();
    const push = await flowpact(
      root,
      ['impact', '--expect', 'patch'],
      ci({ GITHUB_EVENT_NAME: 'push' }, root, { before: parent(root) }),
    );
    expect(push.exitCode).toBe(1);
    expect(push.stdout).toContain('FP810');
    const created = await flowpact(
      root,
      ['impact', '--expect', 'patch'],
      ci({ GITHUB_EVENT_NAME: 'push' }, root, { before: '0'.repeat(40) }),
    );
    expect(created.exitCode).toBe(0);
    expect(created.stderr).toContain('skipped');
  });

  it('skips when the baseline is the checked-out commit', async () => {
    const root = renamed();
    const r = await flowpact(root, ['impact', '--base', head(root), '--expect', 'none']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('is the checked-out commit');
  });

  it('takes the policy from the baseline, not from the pull request', async () => {
    const config = '.github/flowpact/flowpact.config.yml';
    const root = repo(
      { [WF]: reusable('Test') },
      { [WF]: reusable('Unit tests'), [config]: 'impact:\n  publish: ["nothing/*.yml"]\n' },
    );
    const r = await flowpact(root, ['impact', '--base', 'main', '--title', 'fix: x']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('FP810');
    expect(r.stderr).toContain('they apply after it is merged');
  });

  it('takes the policy from the base config too, under the baseline config', async () => {
    const config = '.github/flowpact/flowpact.config.yml';
    const root = repo(
      { [WF]: reusable('Test'), [config]: 'impact:\n  uncertain: warn\n' },
      { [WF]: reusable('Unit tests'), [config]: 'impact:\n  uncertain: warn\n' },
    );
    const base = join(mkdtempSync(join(tmpdir(), 'flowpact-impact-base-')), 'acme.base.yml');
    // An organization where every `fix:` is a major release: the rename is then declared.
    writeFileSync(base, 'impact:\n  types: { fix: major }\n');
    expect((await flowpact(root, ['impact', '--base', 'main', '--title', 'fix: x'])).exitCode).toBe(1);
    const r = await flowpact(root, ['impact', '--base', 'main', '--title', 'fix: x', '--base-config', base]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain('they apply after it is merged');
  });

  it('leaves a base config of the repository out of the baseline, so a pull request cannot relax its own check', async () => {
    const base = '.github/acme.base.yml';
    // The pull request edits the base config in its own tree to declare every fix as major.
    const root = repo(
      { [WF]: reusable('Test'), [base]: 'rules: {}\n' },
      { [WF]: reusable('Unit tests'), [base]: 'impact:\n  types: { fix: major }\n' },
    );
    const r = await flowpact(root, [
      'impact',
      '--base',
      'main',
      '--title',
      'fix: x',
      '--base-config',
      join(root, base),
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('FP810');
    expect(r.stderr).toContain('the base config is a file of this repository');
  });

  it("ignores the baseline config's rule settings, which a pull request may be fixing", async () => {
    const config = '.github/flowpact/flowpact.config.yml';
    const root = repo(
      { [WF]: reusable('Test'), [config]: 'rules:\n  unused-inptu: off\n' },
      { [WF]: reusable('Unit tests'), [config]: 'rules:\n  unused-input: off\n' },
    );
    const r = await flowpact(root, ['impact', '--base', 'main', '--title', 'fix!: rename the test check']);
    expect(r.exitCode).toBe(0);
  });

  it('falls back to the default policy when the baseline config is invalid', async () => {
    const config = '.github/flowpact/flowpact.config.yml';
    const root = repo(
      { [WF]: reusable('Test'), [config]: 'impact:\n  uncertain: sometimes\n' },
      { [WF]: reusable('Unit tests'), [config]: 'impact:\n  uncertain: fail\n' },
    );
    const r = await flowpact(root, ['impact', '--base', 'main', '--title', 'fix: x']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('FP810');
    expect(r.stderr).toContain('is invalid');
  });

  it('reads per-package release settings and component tags', async () => {
    const base = {
      [WF]: reusable('Test'),
      '.release-please-manifest.json': '{ ".": "0.1.0" }\n',
      'release-please-config.json': JSON.stringify({
        packages: {
          '.': { component: 'kit', 'include-component-in-tag': true, 'bump-minor-pre-major': true },
        },
      }),
    };
    const root = repo(base, { [WF]: reusable('Unit tests') });
    git(root, 'tag', 'kit-v0.1.0', 'main');
    git(root, 'checkout', '-q', '-b', 'release');
    write(root, { '.release-please-manifest.json': '{ ".": "0.2.0" }\n' });
    git(root, 'commit', '-q', '-am', 'release');
    const r = await flowpact(root, [
      'impact',
      '--base',
      'change',
      '--title',
      'chore(main): release kit 0.2.0',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).impact).toMatchObject({
      baseline: { kind: 'release', ref: 'kit-v0.1.0' },
      declared: { kind: 'version', level: 'major' },
    });
  });

  it('resolves a symlinked action in the baseline like the working tree', async () => {
    const action = (using: string) => `name: a\ndescription: d\nruns:\n  using: ${using}\n  main: index.js\n`;
    const top = mkdtempSync(join(tmpdir(), 'flowpact-impact-'));
    git(top, 'init', '-q', '-b', 'main');
    git(top, 'config', 'user.email', 't@example.com');
    git(top, 'config', 'user.name', 't');
    git(top, 'config', 'commit.gpgsign', 'false');
    write(top, { 'src/action.yml': action('node20') });
    symlinkSync('src/action.yml', join(top, 'action.yml'));
    git(top, 'add', '-A');
    git(top, 'commit', '-q', '-m', 'base');
    git(top, 'checkout', '-q', '-b', 'change');
    write(top, { 'src/action.yml': action('node24') });
    git(top, 'commit', '-q', '-am', 'change');
    const r = await flowpact(top, ['impact', '--base', 'main', '--title', 'fix: x', '--format', 'json']);
    const impact = JSON.parse(r.stdout).impact;
    expect(impact.changes.map((c: { kind: string }) => c.kind)).not.toContain('unit');
    expect(impact.changes.length).toBeGreaterThan(0);
  });
});

describe('flowpact impact with paths', () => {
  const CONFIG = '.github/flowpact/flowpact.config.yml';
  const action = (name: string, input: boolean) =>
    `name: ${name}\ndescription: action ${name}\ninputs:\n${input ? '  token: { description: t, required: false }\n' : ''}runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo "${input ? '${{ inputs.token }}' : '${{ github.token }}'}"\n`;
  /** Two published actions; the change removes b's input (major) and leaves an empty `inputs:` (FP503 in b). */
  const twoActions = () =>
    repo(
      {
        [CONFIG]: 'impact:\n  publish: ["*/action.yml"]\n',
        'a/action.yml': action('a', true),
        'b/action.yml': action('b', true),
      },
      { 'b/action.yml': action('b', false) },
    );
  const json = async (root: string, args: string[]) => {
    const r = await flowpact(root, [...args, '--base', 'main', '--expect', 'patch', '--format', 'json']);
    const report = JSON.parse(r.stdout);
    return {
      exit: r.exitCode,
      impact: report.impact,
      codes: report.findings.map((f: { code: string }) => f.code),
    };
  };

  it('judges only the published units within the paths, so a change elsewhere neither fails nor shows', async () => {
    const root = twoActions();
    // The bug: lint --impact a printed "required MAJOR ✖" (about b) and exited 0, the FP810 about b hidden.
    const a = await json(root, ['lint', '--impact', 'a']);
    expect(a).toEqual({
      exit: 0,
      impact: expect.objectContaining({
        required: 'none',
        ok: true,
        changes: [],
        scope: { paths: ['a'], units: ['a'] },
      }),
      codes: ['FP812'],
    });
    const b = await json(root, ['lint', '--impact', 'b']);
    expect(b.exit).toBe(1);
    expect(b.impact).toMatchObject({ required: 'major', ok: false, scope: { paths: ['b'], units: ['b'] } });
    expect(b.codes.sort()).toEqual(['FP503', 'FP810']);
    // Without paths, every published unit, as before.
    const all = await json(root, ['lint', '--impact']);
    expect(all.exit).toBe(1);
    expect(all.impact.required).toBe('major');
    expect(all.impact.scope).toBeUndefined();
  });

  it('takes paths in flowpact impact and check --impact, and says so in every report', async () => {
    const root = twoActions();
    expect(await json(root, ['impact', 'a/action.yml'])).toMatchObject({ exit: 0, codes: ['FP812'] });
    expect(await json(root, ['impact', 'b/action.yml'])).toMatchObject({ exit: 1, codes: ['FP810'] });
    expect(await json(root, ['impact', 'a', 'b'])).toMatchObject({
      exit: 1,
      impact: { required: 'major', scope: { paths: ['a', 'b'], units: ['a', 'b'] } },
    });
    expect((await json(root, ['check', '--impact', 'a'])).impact).toMatchObject({
      required: 'none',
      ok: true,
    });
    const pretty = await flowpact(root, ['impact', 'a', '--base', 'main', '--expect', 'patch']);
    expect(pretty.stdout).toContain('only within a: graded a');
    expect(pretty.stdout).toContain('no changes to the published workflows or actions within the paths');
    const markdown = await flowpact(root, [
      'impact',
      'b',
      '--base',
      'main',
      '--expect',
      'patch',
      '--format',
      'markdown',
    ]);
    expect(markdown.stdout).toContain('<sub>Only within `b`: graded `b`</sub>');
  });

  it('grades a unit the change removed through its baseline path, and still refuses unknown paths', async () => {
    const root = repo(
      {
        [CONFIG]: 'impact:\n  publish: ["*/action.yml"]\n',
        'a/action.yml': action('a', true),
        'b/action.yml': action('b', true),
      },
      { 'notes.txt': 'b goes\n' },
    );
    git(root, 'rm', '-rq', 'b');
    git(root, 'commit', '-qm', 'remove b');
    for (const path of ['b', 'b/action.yml']) {
      const removed = await json(root, ['impact', path]);
      expect(removed.exit).toBe(1);
      expect(removed.codes).toEqual(['FP810']);
      expect(removed.impact.changes).toMatchObject([{ unit: 'b', kind: 'unit', level: 'major' }]);
    }
    expect((await json(root, ['lint', '--impact', 'b'])).codes).toEqual(['FP810']);
    const unknown = await flowpact(root, ['impact', 'b', 'nope', '--base', 'main']);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain('Path not found under .: nope');
    // Without impact mode, the removed path is just missing.
    expect((await flowpact(root, ['lint', 'b'])).exitCode).toBe(2);
  });

  it('grades nothing within paths that hold no published unit', async () => {
    const root = repo(
      {
        [WF]: reusable('Test'),
        '.github/workflows/ci.yml':
          'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps: [{ run: "true" }]\n',
      },
      { [WF]: reusable('Unit tests') },
    );
    const r = await json(root, ['impact', '.github/workflows/ci.yml']);
    expect(r.exit).toBe(0);
    expect(r.impact).toMatchObject({ required: 'none', ok: true, changes: [], scope: { units: [] } });
    expect((await json(root, ['impact', '.github/workflows'])).impact).toMatchObject({
      required: 'major',
      scope: { units: [WF] },
    });
  });
});

describe('flowpact impact with paths: where the verdict is reported', () => {
  const CONFIG = '.github/flowpact/flowpact.config.yml';
  const CI = '.github/workflows/ci.yml';
  const action = (name: string) =>
    `name: ${name}\ndescription: action ${name}\ninputs:\n  token: { description: t, required: false }\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo "\${{ inputs.token }}"\n`;
  const ci = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./a\n';
  /** Published actions a and b, no root action.yml, and a CI workflow that is not published. */
  const actions = () =>
    repo(
      {
        [CONFIG]: 'impact:\n  publish: ["*/action.yml"]\n',
        'a/action.yml': action('a'),
        'b/action.yml': action('b'),
      },
      { [CI]: ci },
    );
  const declared = ['--base', 'main', '--title', 'fix: x', '--labels', 'semver:major'];

  it('places the verdict findings on a file within paths that hold no published unit', async () => {
    const root = actions();
    // Before: FP811 and FP812 on action.yml, a file outside the paths that does not even exist.
    const json = await flowpact(root, ['impact', CI, ...declared, '--format', 'json']);
    expect(json.exitCode).toBe(1);
    const report = JSON.parse(json.stdout);
    expect(report.impact).toMatchObject({ required: 'none', ok: false, scope: { paths: [CI], units: [] } });
    expect(
      report.findings.map((f: { code: string; loc: { file: string } }) => `${f.code}@${f.loc.file}`),
    ).toEqual([`FP811@${CI}`, `FP812@${CI}`]);
    const github = await flowpact(root, ['impact', CI, ...declared, '--format', 'github']);
    expect(github.stdout.match(/file=[^,]+/g)).toEqual([`file=${CI}`, `file=${CI}`]);
    const sarif = JSON.parse((await flowpact(root, ['impact', CI, ...declared, '--format', 'sarif'])).stdout);
    expect(
      sarif.runs[0].results.map(
        (r: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }) =>
          r.locations[0]!.physicalLocation.artifactLocation.uri,
      ),
    ).toEqual([CI, CI]);
  });

  it('skips impact mode when the paths hold only what the change removed, none of it published', async () => {
    const root = actions();
    git(root, 'rm', '-q', CI);
    git(root, 'commit', '-qm', 'remove ci');
    // Compared with the commit that still has the CI workflow.
    const declared = ['--base', 'HEAD~1', '--title', 'fix: x', '--labels', 'semver:major'];
    const impact = await flowpact(root, ['impact', CI, ...declared]);
    expect(impact.exitCode).toBe(0);
    expect(impact.stdout).toBe('');
    expect(impact.stderr).toContain('impact: skipped (nothing within the paths to grade or to report on)');
    const lint = await flowpact(root, ['lint', '--impact', CI, ...declared, '--format', 'json']);
    expect(lint.exitCode).toBe(0);
    expect(lint.stderr).toContain('impact: skipped (nothing within the paths to grade or to report on)');
    const report = JSON.parse(lint.stdout);
    expect(report.impact).toBeUndefined();
    expect(report.findings).toEqual([]);
  });

  it('accepts a removed path beside the whole repository', async () => {
    const root = actions();
    git(root, 'rm', '-rq', 'b');
    git(root, 'commit', '-qm', 'remove b');
    const r = await flowpact(root, [
      'impact',
      '.',
      'b',
      '--base',
      'main',
      '--expect',
      'patch',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.impact.scope).toBeUndefined();
    expect(report.findings.map((f: { code: string }) => f.code)).toEqual(['FP810']);
  });
});

describe('flowpact impact with paths the change removed', () => {
  const CONFIG = '.github/flowpact/flowpact.config.yml';
  const action = (name: string) =>
    `name: ${name}\ndescription: action ${name}\ninputs:\n  token: { description: t, required: false }\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo "\${{ inputs.token }}"\n`;
  /** Published actions a and b on main (under `sub`); the branch removes b. */
  const removedB = (sub = '') => {
    const root = repo(
      {
        [CONFIG]: 'impact:\n  publish: ["*/action.yml"]\n',
        'a/action.yml': action('a'),
        'b/action.yml': action('b'),
      },
      { 'notes.txt': 'b goes\n' },
      sub,
    );
    git(root, 'rm', '-rq', 'b');
    git(root, 'commit', '-qm', 'remove b');
    return root;
  };

  it('does not refuse a removed path when impact mode is skipped, and reports nothing about it', async () => {
    const root = removedB();
    // Before: exit 2, "Path not found", in the merge queue after the pull request passed.
    const merge = await flowpact(root, ['lint', '--impact', 'b', '--base', 'main', '--format', 'json'], {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'merge_group',
    });
    expect(merge.exitCode).toBe(0);
    expect(merge.stderr).toContain('impact: skipped (merge_group');
    expect(merge.stderr).toContain(
      'impact: paths not found, not refused while impact mode is skipped (the change may have removed them): b',
    );
    const report = JSON.parse(merge.stdout);
    expect(report.impact).toBeUndefined();
    expect(report.findings).toEqual([]);
    // Skipped because the baseline is the checked-out commit: the same, beside an existing path.
    const same = await flowpact(root, ['lint', '--impact', 'b', 'a', '--base', 'HEAD']);
    expect(same.exitCode).toBe(0);
    expect(same.stderr).toContain('not refused while impact mode is skipped');
    // Without impact mode, still refused.
    expect((await flowpact(root, ['lint', 'b'])).exitCode).toBe(2);
  });

  it('does not refuse a removed unit whose directory keeps other files when impact mode is skipped', async () => {
    const root = repo(
      {
        [CONFIG]: 'impact:\n  publish: ["*/action.yml"]\n',
        'a/action.yml': action('a'),
        'b/action.yml': action('b'),
        'b/README.md': '# b\n',
      },
      { 'notes.txt': 'b goes\n' },
    );
    git(root, 'rm', '-q', 'b/action.yml');
    git(root, 'commit', '-qm', 'remove b, keep its README');
    // The pull request's run grades the removal.
    const pr = await flowpact(root, ['lint', '--impact', 'b', '--base', 'main', '--expect', 'patch']);
    expect(pr.exitCode).toBe(1);
    expect(pr.stdout).toContain('action b was removed or moved');
    // Before: exit 2, "None of the paths is a workflow … or an action", in the merge queue after that run passed.
    const merge = await flowpact(root, ['lint', '--impact', 'b', '--base', 'main', '--format', 'json'], {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'merge_group',
    });
    expect(merge.exitCode).toBe(0);
    expect(merge.stderr).toContain(
      'impact: paths without a workflow or action, not refused while impact mode is skipped (the change may have removed them): b',
    );
    expect(JSON.parse(merge.stdout).findings).toEqual([]);
    // Beside a path that names a workflow or action, b was never refused, so there is nothing to note.
    const beside = await flowpact(root, ['lint', '--impact', 'b', 'a', '--base', 'HEAD']);
    expect(beside.exitCode).toBe(0);
    expect(beside.stderr).not.toContain('not refused');
    // Without impact mode, still refused.
    expect((await flowpact(root, ['lint', 'b'])).exitCode).toBe(2);
  });

  it('takes a removed path relative to the working directory, as an existing one, with --root', async () => {
    const root = removedB('sub');
    const top = dirname(root);
    const r = await flowpact(top, [
      'impact',
      '--root',
      'sub',
      'sub/b',
      '--base',
      'main',
      '--expect',
      'patch',
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('action b was removed or moved');
    // Relative to --root, as before.
    expect(
      (await flowpact(top, ['impact', '--root', 'sub', 'b', '--base', 'main', '--expect', 'patch'])).exitCode,
    ).toBe(1);
    // And a path that is nowhere is still refused.
    const nowhere = await flowpact(top, ['impact', '--root', 'sub', 'sub/c', '--base', 'main']);
    expect(nowhere.exitCode).toBe(2);
  });

  it('knows a removed action that nothing used and nothing published', async () => {
    const root = repo(
      {
        'tools/x/action.yml': action('x'),
        '.github/workflows/ci.yml':
          'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps: [{ run: "true" }]\n',
      },
      { 'notes.txt': 'x goes\n' },
    );
    git(root, 'rm', '-rq', 'tools');
    git(root, 'commit', '-qm', 'remove x');
    const r = await flowpact(root, ['lint', '--impact', 'tools/x', '--base', 'main', '--expect', 'patch']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('impact: skipped (nothing within the paths to grade or to report on)');
  });
});

describe('check with paths and the contracts of what the change removed', () => {
  const CONFIG = '.github/flowpact/flowpact.config.yml';
  const action = (name: string) =>
    `name: ${name}\ndescription: action ${name}\ninputs:\n  token: { description: t, required: false }\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo "\${{ inputs.token }}"\n`;

  it('reports the orphaned contract of a removed unit within the paths', async () => {
    const root = repo(
      {
        [CONFIG]: 'impact:\n  publish: ["actions/*"]\n',
        'actions/keep/action.yml': action('keep'),
        'actions/old/action.yml': action('old'),
      },
      { 'notes.txt': 'old goes\n' },
    );
    // Lock the contracts on the branch, then remove the old action and leave its contract behind.
    expect((await flowpact(root, ['generate'])).exitCode).toBe(0);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'contracts');
    git(root, 'rm', '-rq', 'actions/old');
    git(root, 'commit', '-qm', 'remove old');
    const codes = async (args: string[]) => {
      const r = await flowpact(root, [...args, '--base', 'main', '--expect', 'major', '--format', 'json']);
      return JSON.parse(r.stdout).findings.map(
        (f: { code: string; loc: { file: string } }) => `${f.code}@${f.loc.file}`,
      );
    };
    const orphan = 'FP804@.github/flowpact/contracts/actions/actions__old.contract.yml';
    // Before: FP804 only without paths; the removed unit's own path left its contract out of scope.
    for (const paths of [['actions/old'], ['actions/old/action.yml'], ['actions']])
      expect(await codes(['check', '--impact', ...paths])).toContain(orphan);
    expect(await codes(['check', 'actions'])).toContain(orphan);
    expect(await codes(['check', '--impact'])).toContain(orphan);
    // Outside the paths, it is not in scope.
    expect(await codes(['check', '--impact', 'actions/keep'])).not.toContain(orphan);
    // generate with the same paths deletes it.
    const dry = await flowpact(root, ['generate', 'actions', '--dry-run']);
    expect(dry.stdout).toContain('actions__old.contract.yml');
  });
});
