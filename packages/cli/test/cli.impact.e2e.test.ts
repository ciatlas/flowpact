/** `flowpact impact` and `--impact` on real git repositories (base commit, pull request head, release tags). */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  /** The environment of a run in GitHub Actions on `event`, with its payload. */
  const ci = (root: string, event: string, payload: unknown = {}) => {
    const file = join(root, '..', `event-${event}.json`);
    writeFileSync(file, JSON.stringify(payload));
    return { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: file };
  };
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
    // So on a push that impact mode skips (here a new branch's first push). A push usually follows a pull request's
    // run, which has the baseline and refuses a mistake, but not always: a new branch's first push comes before any.
    // The behaviour is kept there; a workflow that runs only on push refuses a mistake with impact: on instead (which
    // compares a later push with the commit before it).
    const push = await flowpact(
      root,
      ['lint', '--impact', 'b', 'a'],
      ci(root, 'push', { before: '0'.repeat(40) }),
    );
    expect(push.exitCode).toBe(0);
    expect(push.stderr).toContain('not refused while impact mode is skipped');
    // Where no pull request's run comes first, skipped impact mode refuses it as 0.14 did: locally, and on
    // schedule or workflow_dispatch, when the baseline is the checked-out commit. Before: exit 0 with the note.
    for (const env of [{}, ci(root, 'schedule'), ci(root, 'workflow_dispatch')]) {
      const same = await flowpact(root, ['lint', '--impact', 'b', 'a', '--base', 'HEAD'], env);
      expect(same.exitCode).toBe(2);
      expect(same.stderr).toContain('Path not found');
      expect(same.stderr).toContain('is the checked-out commit');
      expect(same.stderr).not.toContain('not refused');
    }
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
    // Refused where no pull request's run comes first. Before: exit 0 with the note.
    const scheduled = await flowpact(root, ['lint', '--impact', 'b', '--base', 'HEAD'], ci(root, 'schedule'));
    expect(scheduled.exitCode).toBe(2);
    expect(scheduled.stderr).toContain('None of the paths is a workflow');
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

describe('ignore and impact mode', () => {
  const CONFIG = '.github/flowpact/flowpact.config.yml';
  const action = (name: string, input: boolean) =>
    `name: ${name}\ndescription: action ${name}\ninputs:\n${input ? '  token: { description: t, required: false }\n' : ''}runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo "${input ? '${{ inputs.token }}' : '${{ github.token }}'}"\n`;

  it('reads ignore from the baseline, so a pull request cannot ignore its way past the gate', async () => {
    // The pull request removes b's input (major, and an empty `inputs:`, FP503) and adds b to ignore.
    const root = repo(
      {
        [CONFIG]: 'impact:\n  publish: ["*/action.yml"]\n',
        'a/action.yml': action('a', true),
        'b/action.yml': action('b', true),
      },
      {
        [CONFIG]: 'ignore: ["b/**"]\nimpact:\n  publish: ["*/action.yml"]\n',
        'b/action.yml': action('b', false),
      },
    );
    const r = await flowpact(root, [
      'lint',
      '--impact',
      '--base',
      'main',
      '--expect',
      'patch',
      '--format',
      'json',
    ]);
    // Before: "required none, ok: true" and exit 0; 0.14 said "required major, ok: false" and exit 0.
    expect(r.exitCode).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.impact).toMatchObject({ required: 'major', ok: false });
    // The other findings follow the pull request's ignore: b's FP503 is left out.
    expect(
      report.findings.map((f: { code: string; loc: { file: string } }) => `${f.code}@${f.loc.file}`),
    ).toEqual(['FP810@b/action.yml']);
    expect(r.stderr).toContain(
      'impact: this pull request changes what ignore leaves out of impact mode (b); that applies after it is merged',
    );
  });

  it('says in every report which published units ignore left out', async () => {
    // main and the pull request both ignore b, which the pull request breaks.
    const root = repo(
      {
        [CONFIG]: 'ignore: ["b/**"]\nimpact:\n  publish: ["*/action.yml"]\n',
        'a/action.yml': action('a', true),
        'b/action.yml': action('b', true),
      },
      { 'b/action.yml': action('b', false) },
    );
    const run = (...args: string[]) =>
      flowpact(root, ['impact', ...args, '--base', 'main', '--expect', 'patch']);
    // Before: "no changes to published workflows or actions", though published b changed.
    const pretty = await run();
    expect(pretty.stdout).not.toContain('no changes to published workflows or actions');
    expect(pretty.stdout).toContain('no changes to the published workflows or actions that ignore leaves in');
    expect(pretty.stdout).toContain('left out by ignore: b');
    const markdown = await run('--format', 'markdown');
    expect(markdown.stdout).toContain(
      'No changes to the published workflows or actions that ignore leaves in.',
    );
    expect(markdown.stdout).toContain('<sub>Left out by ignore: `b`</sub>');
    const report = JSON.parse((await run('--format', 'json')).stdout);
    expect(report.impact).toMatchObject({ required: 'none', ok: true, ignored: ['b'] });
    // With paths, within them.
    const within = await run('a', 'b');
    expect(within.stdout).toContain(
      'no changes to the published workflows or actions within the paths that ignore leaves in',
    );
    expect(within.stdout).toContain('left out by ignore: b');
    expect(JSON.parse((await run('a', '--format', 'json')).stdout).impact.ignored).toBeUndefined();
  });

  it('grades a unit the pull request takes out of ignore, so it cannot pass the gate that way either', async () => {
    // main ignores b; the pull request takes b out of ignore and removes its input in the same change.
    const root = repo(
      {
        [CONFIG]: 'ignore: ["b/**"]\nimpact:\n  publish: ["*/action.yml"]\n',
        'a/action.yml': action('a', true),
        'b/action.yml': action('b', true),
      },
      {
        [CONFIG]: 'impact:\n  publish: ["*/action.yml"]\n',
        'b/action.yml': action('b', false),
      },
    );
    for (const paths of [[], ['b']]) {
      const r = await flowpact(root, [
        'impact',
        ...paths,
        '--base',
        'main',
        '--title',
        'fix: x',
        '--format',
        'json',
      ]);
      // Before: "required none, ok: true" and exit 0 (with paths, impact mode skipped); 0.14 failed with FP810.
      expect(r.exitCode).toBe(1);
      const report = JSON.parse(r.stdout);
      expect(report.impact).toMatchObject({ required: 'major', ok: false });
      expect(
        report.findings.map((f: { code: string; loc: { file: string } }) => `${f.code}@${f.loc.file}`),
      ).toEqual(['FP810@b/action.yml']);
      expect(r.stderr).not.toContain('ignore leaves out');
    }
  });

  it("reads the baseline's version of a base config of the repository for the baseline's ignore", async () => {
    const BASE = '.github/org-base.yml';
    const base = (ignore: string) => ({
      [CONFIG]: 'impact:\n  publish: ["*/action.yml"]\n',
      [BASE]: ignore,
      'a/action.yml': action('a', true),
      'b/action.yml': action('b', true),
    });
    const impact = (root: string, baseConfig: string) =>
      flowpact(root, ['impact', '--base', 'main', '--title', 'fix: x', '--base-config', baseConfig]);
    // main's base config ignores b; the pull request breaks b and leaves every config alone.
    const untouched = repo(base('ignore: ["b/**"]\n'), { 'b/action.yml': action('b', false) });
    const r = await impact(untouched, join(untouched, BASE));
    // Before: "this pull request changes what ignore leaves out of impact mode (b)" and FP810 (exit 1); 0.14 exit 0.
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('FP810');
    expect(r.stderr).not.toContain('changes what ignore leaves out');
    // A base config outside the repository counts for both sides.
    const outside = join(mkdtempSync(join(tmpdir(), 'flowpact-impact-base-')), 'org-base.yml');
    writeFileSync(outside, 'ignore: ["b/**"]\n');
    const o = await impact(repo(base('rules: {}\n'), { 'b/action.yml': action('b', false) }), outside);
    expect(o.exitCode).toBe(0);
    expect(o.stderr).not.toContain('changes what ignore leaves out');
    // The pull request's own edit to the base config adds b to ignore only once it is merged.
    const edited = repo(base('rules: {}\n'), {
      [BASE]: 'ignore: ["b/**"]\n',
      'b/action.yml': action('b', false),
    });
    const e = await impact(edited, join(edited, BASE));
    expect(e.exitCode).toBe(1);
    expect(e.stdout).toContain('FP810');
    expect(e.stderr).toContain(
      'impact: this pull request changes what ignore leaves out of impact mode (b); that applies after it is merged',
    );
    // So does one the baseline lacks, or has in a form flowpact refuses: its ignore does not count there.
    const { [BASE]: _, ...withoutBase } = base('');
    const created = repo(withoutBase, { [BASE]: 'ignore: ["b/**"]\n', 'b/action.yml': action('b', false) });
    expect((await impact(created, join(created, BASE))).exitCode).toBe(1);
    const invalid = repo(base('ignore: ["b/**"]\nplugins: [x.mjs]\n'), {
      [BASE]: 'ignore: ["b/**"]\n',
      'b/action.yml': action('b', false),
    });
    const i = await impact(invalid, join(invalid, BASE));
    expect(i.exitCode).toBe(1);
    expect(i.stderr).toContain(
      `impact: the baseline's ${BASE} is invalid (Invalid base config in ${BASE}); impact mode reads no ignore from it`,
    );
  });

  it('uses a base config of the working tree that the checked-out commit does not track on both sides', async () => {
    // The organization's config checked out into a gitignored directory: no commit of the pull request can edit it.
    const root = repo(
      {
        [CONFIG]: 'impact:\n  publish: ["*/action.yml"]\n',
        '.gitignore': '.org/\n',
        'a/action.yml': action('a', true),
        'b/action.yml': action('b', true),
      },
      { 'b/action.yml': action('b', false) },
    );
    write(root, { '.org/base.yml': 'ignore: ["b/**"]\n' });
    const r = await flowpact(root, [
      'impact',
      '--base',
      'main',
      '--title',
      'fix: x',
      '--base-config',
      '.org/base.yml',
      '--format',
      'json',
    ]);
    // Before: b was graded with "this pull request changes what ignore leaves out of impact mode (b); that applies
    // after it is merged" and FP810 (exit 1), though nothing changed and the baseline never reads the file.
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).impact).toMatchObject({ required: 'none', ok: true, ignored: ['b'] });
    expect(r.stderr).not.toContain('changes what ignore leaves out');
    expect(r.stderr).not.toContain('a file of this repository');
  });

  it('takes a tracked base config written in another case for the tracked file, where the file system ignores case', async (ctx) => {
    // On macOS and Windows `.GITHUB/ORG-BASE.yml` opens `.github/org-base.yml`; read as written, git did not track it,
    // so the pull request's own ignore edit counted on the baseline's side too and b was left out of grading.
    const root = repo(
      {
        [CONFIG]: 'impact:\n  publish: ["*/action.yml"]\n',
        '.github/org-base.yml': 'rules: {}\n',
        'a/action.yml': action('a', true),
        'b/action.yml': action('b', true),
      },
      { '.github/org-base.yml': 'ignore: ["b/**"]\n', 'b/action.yml': action('b', false) },
    );
    if (!existsSync(join(root, '.GITHUB/ORG-BASE.yml'))) ctx.skip();
    const r = await flowpact(root, [
      'impact',
      '--base',
      'main',
      '--title',
      'fix: x',
      '--base-config',
      '.GITHUB/ORG-BASE.yml',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).impact).toMatchObject({ required: 'major', ok: false });
    expect(r.stderr).toContain('changes what ignore leaves out');
  });

  it('does not note an ignore edit that leaves out no file of the unit once merged', async () => {
    // The pull request moves b/action.yml to b/action.yaml, breaks it and adds the old file to ignore.
    const root = repo(
      {
        [CONFIG]: 'impact:\n  publish: ["*/action.yml", "*/action.yaml"]\n',
        'a/action.yml': action('a', true),
        'b/action.yml': action('b', true),
      },
      { [CONFIG]: 'ignore: ["b/action.yml"]\nimpact:\n  publish: ["*/action.yml", "*/action.yaml"]\n' },
    );
    git(root, 'mv', 'b/action.yml', 'b/action.yaml');
    write(root, { 'b/action.yaml': action('b', false) });
    git(root, 'commit', '-q', '-am', 'move b');
    const r = await flowpact(root, ['impact', '--base', 'main', '--title', 'fix: x', '--format', 'json']);
    expect(r.exitCode).toBe(1);
    expect(
      JSON.parse(r.stdout).findings.map(
        (f: { code: string; loc: { file: string } }) => `${f.code}@${f.loc.file}`,
      ),
    ).toEqual(['FP810@b/action.yaml']);
    // Before: "this pull request changes what ignore leaves out of impact mode (b); that applies after it is merged",
    // though once merged ignore matches no file of b.
    expect(r.stderr).not.toContain('ignore leaves out');
  });

  describe('a base config reached through a symbolic link', () => {
    const BASE = '.github/base.yml';
    const IGNORES_B = 'ignore: ["b/**"]\n';
    /**
     * Published actions a and b and the files `files` on main, with the symbolic links `links` (path → target); the
     * change breaks b and sets the links `moved`.
     */
    function linked(
      files: Record<string, string>,
      links: Record<string, string>,
      moved: Record<string, string>,
    ): string {
      const top = mkdtempSync(join(tmpdir(), 'flowpact-impact-'));
      git(top, 'init', '-q', '-b', 'main');
      git(top, 'config', 'user.email', 't@example.com');
      git(top, 'config', 'user.name', 't');
      git(top, 'config', 'commit.gpgsign', 'false');
      const link = (all: Record<string, string>) => {
        for (const [path, target] of Object.entries(all)) {
          rmSync(join(top, path), { force: true });
          mkdirSync(dirname(join(top, path)), { recursive: true });
          symlinkSync(target, join(top, path));
        }
      };
      write(top, {
        [CONFIG]: 'impact:\n  publish: ["*/action.yml"]\n',
        'a/action.yml': action('a', true),
        'b/action.yml': action('b', true),
        ...files,
      });
      link(links);
      git(top, 'add', '-A');
      git(top, 'commit', '-q', '-m', 'base');
      git(top, 'checkout', '-q', '-b', 'change');
      link(moved);
      write(top, { 'b/action.yml': action('b', false) });
      git(top, 'add', '-A');
      git(top, 'commit', '-q', '-m', 'change');
      return top;
    }
    const impact = (root: string, baseConfig = BASE) =>
      flowpact(root, [
        'impact',
        '--base',
        'main',
        '--title',
        'fix: x',
        '--base-config',
        baseConfig,
        '--format',
        'json',
      ]);
    const CONFIGS = { '.github/org/strict.yml': 'ignore: []\n', '.github/org/loose.yml': IGNORES_B };

    it('compares what a tracked link points at on each side, so a pull request cannot repoint it past the gate', async () => {
      const r = await impact(linked(CONFIGS, { [BASE]: 'org/strict.yml' }, { [BASE]: 'org/loose.yml' }));
      // Before: the baseline read the pull request's target, so b was left out: "required none, ok: true" and exit 0.
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout).impact).toMatchObject({ required: 'major', ok: false });
      expect(r.stderr).toContain(
        'impact: this pull request changes what ignore leaves out of impact mode (b); that applies after it is merged',
      );
      // A link the pull request leaves alone points at the same config on both sides.
      const kept = await impact(linked(CONFIGS, { [BASE]: 'org/loose.yml' }, {}));
      expect(kept.exitCode).toBe(0);
      expect(JSON.parse(kept.stdout).impact).toMatchObject({ required: 'none', ok: true, ignored: ['b'] });
      expect(kept.stderr).not.toContain('ignore leaves out');
    });

    it('follows a linked directory on the way as each side has it', async () => {
      const root = linked(
        { '.github/strict/base.yml': 'ignore: []\n', '.github/loose/base.yml': IGNORES_B },
        { '.github/org': 'strict' },
        { '.github/org': 'loose' },
      );
      const r = await impact(root, '.github/org/base.yml');
      // Before: exit 0, with b left out.
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout).impact).toMatchObject({ required: 'major', ok: false });
      expect(r.stderr).toContain('changes what ignore leaves out of impact mode (b)');
    });

    it('reads the config a tracked link points at from the working tree when no commit tracks it', async () => {
      // The organization's configs checked out into a gitignored directory; the pull request repoints the link.
      const root = linked(
        { '.gitignore': '.org/\n' },
        { [BASE]: '../.org/strict.yml' },
        { [BASE]: '../.org/loose.yml' },
      );
      write(root, { '.org/strict.yml': 'ignore: []\n', '.org/loose.yml': IGNORES_B });
      const r = await impact(root);
      // Before: the target was taken for a file no commit tracks, the same on both sides: exit 0, with b left out.
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout).impact).toMatchObject({ required: 'major', ok: false });
      expect(r.stderr).toContain('changes what ignore leaves out of impact mode (b)');
    });

    it('follows a link no commit tracks to the tracked config it points at', async () => {
      // The pull request edits the tracked config that an untracked link (made by an earlier step) points at.
      const root = linked({ '.github/org/strict.yml': 'ignore: []\n' }, {}, {});
      write(root, { '.github/org/strict.yml': IGNORES_B });
      git(root, 'commit', '-q', '-am', 'ignore b');
      symlinkSync('org/strict.yml', join(root, BASE));
      const r = await impact(root);
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout).impact).toMatchObject({ required: 'major', ok: false });
      expect(r.stderr).toContain('changes what ignore leaves out of impact mode (b)');
    });
  });

  describe('a base config within a submodule', () => {
    /**
     * Published actions a and b, and the base config `.org/base.yml` in the submodule `.org` (an embedded repository
     * holding each of `versions` in turn). Main records the submodule at `versions[baseAt]` (or at a commit the clone
     * lacks), the change at `versions[headAt]`, and breaks b.
     */
    function withSubmodule(versions: string[], baseAt: number | 'missing', headAt: number): string {
      const top = repo(
        { [CONFIG]: 'impact:\n  publish: ["*/action.yml"]\n' },
        { 'a/action.yml': action('a', true) },
      );
      git(top, 'checkout', '-q', 'main');
      write(top, { 'a/action.yml': action('a', true), 'b/action.yml': action('b', true) });
      const org = join(top, '.org');
      mkdirSync(org);
      git(org, 'init', '-q', '-b', 'main');
      git(org, 'config', 'user.email', 't@example.com');
      git(org, 'config', 'user.name', 't');
      git(org, 'config', 'commit.gpgsign', 'false');
      const commits = versions.map((text, i) => {
        write(org, { 'base.yml': text });
        git(org, 'add', '-A');
        git(org, 'commit', '-q', '-m', `v${i + 1}`);
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: org }).toString().trim();
      });
      git(top, 'add', 'a', 'b');
      if (baseAt === 'missing')
        git(top, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},.org`);
      else {
        git(org, 'checkout', '-q', commits[baseAt]!);
        git(top, 'add', '.org');
      }
      git(top, 'commit', '-q', '-m', 'base with the submodule');
      git(top, 'checkout', '-q', '-B', 'change');
      git(org, 'checkout', '-q', commits[headAt]!);
      write(top, { 'b/action.yml': action('b', false) });
      git(top, 'add', 'b', '.org');
      git(top, 'commit', '-q', '-m', 'change');
      return top;
    }
    const impact = (root: string, baseConfig = '.org/base.yml', ...args: string[]) =>
      flowpact(root, ['impact', '--base', 'main', '--title', 'fix: x', '--base-config', baseConfig, ...args]);
    const IGNORES_B = 'ignore: ["b/**"]\n';

    it('uses a config generated in a submodule that no commit of it tracks on both sides', async () => {
      const root = withSubmodule(['ignore: []\n'], 0, 0);
      write(root, { '.org/gen.yml': IGNORES_B });
      const r = await impact(root, '.org/gen.yml', '--format', 'json');
      // Before: "this pull request changes what ignore leaves out of impact mode (b); that applies after it is merged"
      // and FP810 (exit 1): the baseline's commit of the submodule lacks the file, so its ignore did not count there.
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).impact).toMatchObject({ required: 'none', ok: true, ignored: ['b'] });
      expect(r.stderr).not.toContain('ignore leaves out');
      expect(r.stderr).not.toContain('a file of this repository');
    });

    it('notes only what the commit the pull request records for the submodule leaves out', async () => {
      // The pull request keeps v1, which ignores nothing; the submodule is checked out at v2, which ignores b.
      const root = withSubmodule(['ignore: []\n', IGNORES_B], 0, 0);
      git(join(root, '.org'), 'checkout', '-q', 'main');
      const r = await impact(root);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('FP810');
      // Before: "this pull request changes what ignore leaves out of impact mode (b); that applies after it is merged".
      expect(r.stderr).not.toContain('ignore leaves out');
      // The pull request moves the submodule to v2, which no longer ignores b, while the one checked out (v1) does:
      // b is graded, as it leaves the baseline's ignore. Before: left out, exit 0.
      const moved = withSubmodule([IGNORES_B, 'ignore: []\n'], 0, 1);
      git(join(moved, '.org'), 'checkout', '-q', 'HEAD~1');
      const m = await impact(moved);
      expect(m.exitCode).toBe(1);
      expect(m.stdout).toContain('FP810');
      expect(m.stderr).not.toContain('ignore leaves out');
    });

    it("reads it at the baseline's commit of the submodule, so one the pull request leaves alone counts on both sides", async () => {
      const r = await impact(withSubmodule([IGNORES_B], 0, 0));
      // Before: b was graded with "this pull request changes what ignore leaves out of impact mode (b); that applies
      // after it is merged" and FP810 (exit 1), though the submodule did not move.
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('FP810');
      expect(r.stderr).not.toContain('ignore leaves out');
    });

    it('grades what a pull request that moves the submodule adds to its ignore, until it is merged', async () => {
      const r = await impact(withSubmodule(['ignore: []\n', IGNORES_B], 0, 1));
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('FP810');
      expect(r.stderr).toContain(
        'impact: this pull request changes what ignore leaves out of impact mode (b); that applies after it is merged',
      );
    });

    it("grades what it leaves out, and says why, when the clone lacks the baseline's commit of the submodule", async () => {
      const r = await impact(withSubmodule([IGNORES_B], 'missing', 0));
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('FP810');
      // Before: "…; that applies after it is merged", which nothing here can tell.
      expect(r.stderr).not.toContain('applies after it is merged');
      expect(r.stderr).toContain(
        "impact: the baseline's version of the base config .org/base.yml is in the submodule .org at 1111111, which this clone lacks, so impact mode reads no ignore from it for the baseline",
      );
      expect(r.stderr).toContain(
        "impact: the baseline's ignore lacks what the pull request's leaves out of impact mode (b), as the baseline's version of .org/base.yml cannot be read; they are graded",
      );
    });
  });
});

describe('ignore that leaves out every published unit', () => {
  const CONFIG = '.github/flowpact/flowpact.config.yml';
  const CI = '.github/workflows/ci.yml';
  const action = (name: string, input: boolean) =>
    `name: ${name}\ndescription: action ${name}\ninputs:\n${input ? '  token: { description: t, required: false }\n' : ''}runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo "${input ? '${{ inputs.token }}' : '${{ github.token }}'}"\n`;
  /** Published actions a and b, both ignored on main, no root action.yml, and a CI workflow; the change breaks b. */
  const ignored = (ignore: string) =>
    repo(
      {
        [CONFIG]: `ignore: ["${ignore}"]\nimpact:\n  publish: ["*/action.yml"]\n`,
        'a/action.yml': action('a', true),
        'b/action.yml': action('b', true),
        [CI]: 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./a\n',
      },
      { 'b/action.yml': action('b', false) },
    );
  const declared = ['--base', 'main', '--title', 'fix: x', '--labels', 'semver:major'];

  it('reports the verdict on a file that ignore leaves in', async () => {
    const r = await flowpact(ignored('*/action.yml'), ['impact', ...declared, '--format', 'json']);
    // Before: FP811 and FP812 on action.yml, which this repository does not have.
    expect(r.exitCode).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.impact).toMatchObject({ required: 'none', ok: false, changes: [] });
    expect(
      report.findings.map((f: { code: string; loc: { file: string } }) => `${f.code}@${f.loc.file}`),
    ).toEqual([`FP811@${CI}`, `FP812@${CI}`]);
  });

  it('skips impact mode when ignore leaves out every workflow and action', async () => {
    const root = ignored('**');
    const r = await flowpact(root, ['impact', ...declared]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(
      'impact: skipped (every workflow and action is ignored: nothing to grade or to report on)',
    );
  });

  it('runs with paths that hold only ignored published units when a file within them is left in', async () => {
    const root = ignored('*/action.yml');
    // The paths hold b, which ignore leaves out, and the CI workflow: the verdict goes on the workflow.
    const r = await flowpact(root, ['impact', 'b', CI, ...declared, '--format', 'json']);
    expect(r.exitCode).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.impact).toMatchObject({ required: 'none', ok: false });
    expect(
      report.findings.map((f: { code: string; loc: { file: string } }) => `${f.code}@${f.loc.file}`),
    ).toEqual([`FP811@${CI}`, `FP812@${CI}`]);
    // Only b: nothing within the paths is left to report on, and the skip says it was ignore. Before: "nothing within
    // the paths to grade or to report on".
    const only = await flowpact(root, ['impact', 'b', ...declared]);
    expect(only.exitCode).toBe(0);
    expect(only.stdout).toBe('');
    expect(only.stderr).toContain(
      'impact: skipped (every workflow and action within the paths is ignored: nothing to grade or to report on)',
    );
  });
});
