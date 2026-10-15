/**
 * Renders documentation screenshots from real `flowpact` runs against the fixture repositories, so the docs always show
 * the current output, and the docs' generated partials: the call graph of a fixture and the action's job summary.
 * Requires a built CLI (`pnpm build`).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyze, loadConfig } from '@flowpact/lint';
import { renderMarkdown } from '@flowpact/reporters';
import { ansiToSvg } from './ansi-svg';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'packages/cli/dist/index.js');
const OUT = join(ROOT, 'apps/docs/public/screenshots');
/** Partials the docs pages include, outside the page tree. */
const GENERATED = join(ROOT, 'apps/docs/content/generated');

/** Git without the user's or the system's settings (signing, hooks, line endings), so commits are reproducible. */
const GIT_CONFIG = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };

type Edit = (file: string, from: string, to: string) => void;

interface Shot {
  name: string;
  fixture: string;
  args: string[];
  title: string;
  /** Keep only the first N lines (long outputs). */
  head?: number;
  /**
   * Run in a temporary git repository instead of the fixture, for impact mode: the fixture is committed as
   * `origin/main`, then these edits are committed on a branch.
   */
  change?: (edit: Edit) => void;
  /** What a stand-in for the GitHub API answers, by request path; the run reads it through `GITHUB_API_URL`. */
  api?: Record<string, string>;
}

/**
 * fixtures/remote-calls' lockfile records octo/setup@v2 at e3b1c7a. Here the tag has moved to a commit whose action no
 * longer declares `registry-auth`, which release.yml passes; octo/ship@v1 has not moved.
 */
const SETUP_MOVED = '9d4e2f17c8a6b3e05f1d7c2a8e4b6f9031c5d7a2';
const MOVED_TAG: Record<string, string> = {
  '/repos/octo/setup/commits/v2': SETUP_MOVED,
  [`/repos/octo/setup/contents/action.yml?ref=${SETUP_MOVED}`]: `name: Set up the toolchain
description: Installs Node.js and restores the dependency cache.
inputs:
  node-version:
    description: The Node.js version to install.
    required: true
  cache-dependency-path:
    description: The lockfile whose hash keys the cache.
runs:
  using: node24
  main: dist/index.js
`,
  '/repos/octo/ship/commits/v1': '4a7c9e1b3d5f7092e4c6a8b0d2f4e6a8c0b2d4f6',
};

const shots: Shot[] = [
  {
    name: 'lint-incident',
    fixture: 'incident-matrix',
    args: ['lint'],
    title: 'flowpact lint — the missing matrix variant',
  },
  {
    name: 'lint-deep-nesting',
    fixture: 'deep-nesting',
    args: ['lint', '--hide-info'],
    title: 'flowpact lint — nested reusable workflows',
    head: 70,
  },
  { name: 'lint-summary', fixture: 'deep-nesting', args: ['lint', '-q'], title: 'Summary card', head: -22 },
  { name: 'lint-clean', fixture: 'clean', args: ['lint'], title: 'A clean run' },
  {
    name: 'trace-down',
    fixture: 'deep-nesting',
    args: ['trace', 'pipeline.yml:environment'],
    title: 'flowpact trace — where does a value go?',
  },
  {
    name: 'trace-up',
    fixture: 'incident-matrix',
    args: ['trace', 'run-suite.yml:config', '--up'],
    title: 'flowpact trace --up — where does a value come from?',
  },
  {
    name: 'generate-dry-run',
    fixture: 'deep-nesting',
    args: ['generate', '--dry-run'],
    title: 'flowpact generate --dry-run — preview the contracts',
    head: 40,
  },
  {
    name: 'check-drift',
    fixture: 'contracts-drift',
    args: ['check', '--hide-info'],
    title: 'flowpact check — drift, breaking changes and overrides',
  },
  {
    name: 'impact',
    fixture: 'clean',
    // test.yml is a published reusable workflow. Naming its job changes the check consumers require from
    // "… / unit" to "… / Unit tests", and its output goes away: both are major, and the title declares a patch.
    change: (edit) => {
      edit('.github/workflows/test.yml', '  unit:\n', '  unit:\n    name: Unit tests\n');
      edit(
        '.github/workflows/test.yml',
        '    outputs:\n      report:\n        description: Path of the test report\n        value: ${{ jobs.unit.outputs.report }}\n',
        '',
      );
    },
    args: ['impact', '--base', 'origin/main', '--title', 'fix: tidy the test job'],
    title: 'flowpact impact — a renamed check declared as a patch',
  },
  { name: 'graph-tree', fixture: 'deep-nesting', args: ['graph'], title: 'flowpact graph — who calls whom' },
  {
    name: 'lint-remote',
    fixture: 'remote-calls',
    args: ['lint'],
    title: 'flowpact lint — calls into other repositories, checked against the lockfile',
  },
  {
    name: 'remotes-update',
    fixture: 'remote-calls',
    args: ['remotes', 'update', '--dry-run', '--fail-on', 'breaks'],
    title: 'flowpact remotes update — a tag that moved, graded against your calls',
    api: MOVED_TAG,
  },
  { name: 'explain', fixture: 'clean', args: ['explain', 'FP401'], title: 'flowpact explain FP401' },
  { name: 'rules', fixture: 'clean', args: ['rules'], title: 'flowpact rules', head: 24 },
  {
    name: 'debug',
    fixture: 'incident-matrix',
    args: ['lint', '--debug', '--only', 'FP401'],
    title: 'flowpact lint --debug',
    head: 30,
  },
];

/**
 * A temporary git repository holding the fixture's tracked files (an untracked .DS_Store would change the hashes),
 * committed on main and as `origin/main`, then `change` committed on a branch. Fixed identities and dates keep the
 * baseline commit the same on every run.
 */
function changedRepository(fixture: string, change: (edit: Edit) => void): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flowpact-shot-')));
  const env = {
    ...process.env,
    ...GIT_CONFIG,
    GIT_AUTHOR_NAME: 'Docs',
    GIT_AUTHOR_EMAIL: 'docs@example.com',
    GIT_AUTHOR_DATE: '2026-01-01T12:00:00Z',
    GIT_COMMITTER_NAME: 'Docs',
    GIT_COMMITTER_EMAIL: 'docs@example.com',
    GIT_COMMITTER_DATE: '2026-01-01T12:00:00Z',
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  try {
    const prefix = `fixtures/${fixture}/`;
    const files = execFileSync('git', ['ls-files', '-z', '--', prefix], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    for (const file of files) {
      const to = join(dir, file.slice(prefix.length));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(join(ROOT, file)));
    }
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'Initial commit');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-b', 'change');
    change((file, from, to) => {
      const path = join(dir, file);
      const text = readFileSync(path, 'utf8');
      if (!text.includes(from))
        throw new Error(`fixtures/${fixture}/${file} does not contain ${JSON.stringify(from)}`);
      writeFileSync(path, text.replace(from, to));
    });
    git('commit', '-q', '-a', '-m', 'Change');
    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Answers `files` by request path, and 404 for anything else, on a free local port. */
async function apiStandIn(files: Record<string, string>) {
  const server = createServer((req, res) => {
    const body = files[req.url ?? ''];
    res.writeHead(body === undefined ? 404 : 200).end(body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

/**
 * The environment a shot runs in. With a stand-in for the GitHub API, the run reads it with a placeholder token (the
 * output names its source, not its value) and keeps the sources it would cache in a directory of its own.
 */
function shotEnv(shot: Shot, standIn?: { url: string; cache: string }): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORCE_COLOR: '1',
    NO_COLOR: undefined,
    COLUMNS: '104',
    FLOWPACT_DEBUG: undefined,
    GITHUB_REPOSITORY: 'acme/app',
    // In GitHub Actions, impact mode reads the run's event: here the docs workflow's, not a pull request's.
    ...(shot.change ? { ...GIT_CONFIG, GITHUB_ACTIONS: undefined } : {}),
    ...(standIn
      ? {
          GITHUB_API_URL: standIn.url,
          GH_TOKEN: 'placeholder',
          GITHUB_TOKEN: undefined,
          FLOWPACT_CACHE_DIR: standIn.cache,
        }
      : {}),
  };
}

/** Runs node with `args` and collects what it prints. */
function runNode(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn('node', args, { cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on('close', (status) => resolve({ status, stdout, stderr })),
  );
}

/** Runs the CLI for a shot, with its stand-in for the GitHub API when it has one. */
async function runShot(shot: Shot, cwd: string) {
  if (!shot.api) return runNode([BIN, ...shot.args], cwd, shotEnv(shot));
  const api = await apiStandIn(shot.api);
  const cache = mkdtempSync(join(tmpdir(), 'flowpact-shot-cache-'));
  try {
    return await runNode([BIN, ...shot.args], cwd, shotEnv(shot, { url: api.url, cache }));
  } finally {
    api.close();
    rmSync(cache, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
for (const shot of shots) {
  const cwd = shot.change
    ? changedRepository(shot.fixture, shot.change)
    : join(ROOT, 'fixtures', shot.fixture);
  const res = await runShot(shot, cwd);
  if (shot.change) rmSync(cwd, { recursive: true, force: true });
  // Banner and logs go to stderr, the report to stdout; show them in reading order. Debug logs print absolute paths:
  // show a runner's checkout, not the machine that generated the screenshots.
  let text = `${res.stderr}${res.stdout}`
    .split(cwd)
    .join('/home/runner/work/app/app')
    .split(ROOT)
    .join('/home/runner/work/flowpact/flowpact')
    // Timings vary from run to run: show fixed ones, and keep what follows in its column (the summary card's border)
    // when the real one is wider or narrower.
    .replace(
      /(\d+(\.\d+)? ?ms\b)((?:\u001B\[[\d;]*m)*)( *)/g,
      (_, time: string, decimals: string | undefined, codes: string, pad: string) => {
        const fixed = decimals ? '0.42 ms' : '12 ms';
        return `${fixed}${codes}${pad && ' '.repeat(Math.max(1, pad.length + time.length - fixed.length))}`;
      },
    )
    // Debug log timings: the analysis total like the summary's, every stage the same small value.
    .replace(/^.*"ms":.*$/gm, (line) =>
      line.replace(/("ms":)\d+(?:\.\d+)?/g, `$1${line.includes('analysis finished') ? '12' : '0.42'}`),
    );
  const lines = text.split('\n');
  if (shot.head && shot.head > 0 && lines.length > shot.head)
    text = [...lines.slice(0, shot.head), '\u001B[2m  …\u001B[0m'].join('\n');
  if (shot.head && shot.head < 0) text = lines.slice(shot.head).join('\n');
  const prompt = `flowpact ${shot.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  writeFileSync(join(OUT, `${shot.name}.svg`), ansiToSvg(text, { title: shot.title, prompt }));
  console.log(`${shot.name}.svg (exit ${res.status})`);
}

/**
 * The call graph of a fixture as `flowpact graph` writes it in Mermaid, with the title every docs chart needs, and drawn
 * top-down: a chain of workflows drawn left to right is too small to read in a docs column.
 */
function graphChart(fixture: string, title: string): string {
  const res = spawnSync('node', [BIN, 'graph', '--format', 'mermaid'], {
    cwd: join(ROOT, 'fixtures', fixture),
    env: { ...process.env, NO_COLOR: '1', FLOWPACT_DEBUG: undefined },
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`flowpact graph on ${fixture} exited ${res.status}: ${res.stderr}`);
  return res.stdout.replace(/^flowchart \w+$/m, `flowchart TD\n  accTitle: ${title}`);
}

/** The job summary the action writes in lint mode for a fixture, without links to a repository and with a fixed time. */
function jobSummary(fixture: string): string {
  const root = join(ROOT, 'fixtures', fixture);
  const loaded = loadConfig(root);
  const result = analyze({ root, config: loaded.config, repository: 'acme/app' });
  return renderMarkdown(result, { title: 'flowpact lint' }).replace(/ · \d+ ms<\/sub>/, ' · 12 ms</sub>');
}

mkdirSync(GENERATED, { recursive: true });
writeFileSync(
  join(GENERATED, 'deep-nesting.mmd'),
  graphChart('deep-nesting', 'The deep-nesting fixture, from flowpact graph --format mermaid'),
);
writeFileSync(join(GENERATED, 'summary-incident.md'), jobSummary('incident-matrix'));
console.log('deep-nesting.mmd, summary-incident.md');
