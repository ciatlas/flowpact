import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportSchema, VERSION } from '@flowpact/lint';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/dist/index.js');
const fixture = (name: string) => join(ROOT, 'fixtures', name);

const SCRUB = [
  'NO_COLOR',
  'FORCE_COLOR',
  'FLOWPACT_DEBUG',
  'RUNNER_DEBUG',
  'ACTIONS_STEP_DEBUG',
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_SERVER_URL',
  'GITHUB_SHA',
  'GITHUB_WORKSPACE',
];

/** Runs the built CLI with a controlled environment (no inherited color/debug/Actions settings). */
const flowpact = (args: string[], env: Record<string, string> = { NO_COLOR: '1' }) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUB.includes(k)));
  return execa('node', [BIN, ...args], {
    reject: false,
    cwd: ROOT,
    extendEnv: false,
    env: { ...base, GITHUB_REPOSITORY: 'acme/fixtures', ...env },
  });
};

describe('flowpact graph', () => {
  it('prints a tree by default with cycles, remote and missing targets', async () => {
    const r = await flowpact(['graph', '--root', fixture('cycles')]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain(`v${VERSION}`);
    expect(r.stdout).toContain('Main (.github/workflows/main.yml)');
    expect(r.stdout).toContain('jobs.back → B (.github/workflows/b.yml) ↻ cycle');
    expect(r.stdout).toContain('.github/workflows/does-not-exist.yml (missing)');
    expect(r.stdout).toContain('octo-org/shared/.github/workflows/lint.yml@v2 (remote)');
    expect(r.stdout).not.toMatch(/\u001B\[/);
  });

  it('prints Mermaid, DOT and JSON', async () => {
    const mermaid = await flowpact([
      'graph',
      '--root',
      fixture('composite-actions'),
      '--format',
      'mermaid',
      '-q',
    ]);
    expect(mermaid.stdout).toMatch(/^flowchart LR\n/);
    expect(mermaid.stdout).toContain('act_install_tools{{');
    const dot = await flowpact(['graph', '--root', fixture('deep-nesting'), '--format', 'dot', '-q']);
    expect(dot.stdout).toMatch(/^digraph flowpact \{/);
    expect(dot.stdout).toContain('label="jobs.build (inherit)"');
    const json = await flowpact(['graph', '--root', fixture('cycles'), '--format', 'json', '-q']);
    const graph = JSON.parse(json.stdout);
    expect(graph.nodes.map((n: { kind: string }) => n.kind)).toEqual([
      'workflow',
      'workflow',
      'workflow',
      'remote',
      'missing',
    ]);
    expect(graph.edges).toContainEqual({
      from: '.github/workflows/main.yml',
      to: '.github/workflows/b.yml',
      via: 'jobs.stage-b',
      kind: 'calls',
    });
  });

  it('rejects unknown formats and empty repositories', async () => {
    expect((await flowpact(['graph', '--root', fixture('cycles'), '--format', 'svg'])).exitCode).not.toBe(0);
    const empty = await flowpact(['graph', '--root', mkdtempSync(join(tmpdir(), 'flowpact-empty-'))]);
    expect(empty.exitCode).toBe(2);
    expect(empty.stderr).toContain('No workflows found');
  });
});

describe('flowpact lint output formats', () => {
  it('prints SARIF with --format sarif', async () => {
    const r = await flowpact(['lint', '--root', fixture('incident-matrix'), '--format', 'sarif']);
    expect(r.exitCode).toBe(1);
    const sarif = JSON.parse(r.stdout);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver.version).toBe(VERSION);
    expect(sarif.runs[0].results[0]).toMatchObject({ ruleId: 'FP401', level: 'error' });
  });

  it('prints Markdown with --format markdown, with the call graph on request', async () => {
    const r = await flowpact([
      'lint',
      '--root',
      fixture('deep-nesting'),
      '--format',
      'markdown',
      '--include-graph',
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/^## flowpact report\n/);
    expect(r.stdout).toContain('❌ **4 errors**');
    expect(r.stdout).toContain('```mermaid\nflowchart LR');
    expect(r.stdout).not.toContain('/blob/');
  });

  it('links Markdown locations to the commit inside GitHub Actions', async () => {
    const r = await flowpact(['lint', '--root', fixture('incident-matrix'), '--format', 'markdown', '-q'], {
      NO_COLOR: '1',
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_SHA: 'abc123',
    });
    expect(r.stdout).toContain(
      '(https://github.com/acme/fixtures/blob/abc123/.github/workflows/tests.yml#L23)',
    );
  });

  it('picks the -o format by extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowpact-fmt-'));
    const root = fixture('incident-matrix');
    for (const file of ['r.sarif', 'r.sarif.json', 'r.json', 'r.md', 'r.txt']) {
      const r = await flowpact(['lint', '--root', root, '-o', join(dir, file)]);
      expect(r.stderr).toContain('report written to');
    }
    const read = (f: string) => readFileSync(join(dir, f), 'utf8');
    expect(JSON.parse(read('r.sarif')).version).toBe('2.1.0');
    expect(JSON.parse(read('r.sarif.json')).version).toBe('2.1.0');
    expect(reportSchema.safeParse(JSON.parse(read('r.json'))).success).toBe(true);
    expect(read('r.md')).toMatch(/^## flowpact report\n/);
    expect(read('r.txt')).toContain('FP401 empty-binding-for-matrix-combo');
  });

  it('writes several reports in one run, and takes the format from a prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowpact-multi-'));
    const root = fixture('incident-matrix');
    const r = await flowpact([
      'lint',
      '--root',
      root,
      '-q',
      '-o',
      join(dir, 'r.sarif'),
      `--output=json:${join(dir, 'report')}`,
      '-o',
      `markdown:${join(dir, 'summary')}`,
    ]);
    expect(r.exitCode).toBe(1);
    const read = (f: string) => readFileSync(join(dir, f), 'utf8');
    expect(JSON.parse(read('r.sarif')).version).toBe('2.1.0');
    expect(reportSchema.safeParse(JSON.parse(read('report'))).success).toBe(true);
    expect(read('summary')).toMatch(/^## flowpact report\n/);
    const github = await flowpact(['lint', '--root', root, '-o', `github:${join(dir, 'x')}`]);
    expect(github.exitCode).toBe(2);
    expect(github.stderr).toContain('use --format github');
  });

  it('prints GitHub annotations with --format github', async () => {
    const r = await flowpact(['lint', '--root', fixture('incident-matrix'), '--format', 'github', '-q']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(
      /^::error title=FP401 empty-binding-for-matrix-combo,file=\.github\/workflows\/tests\.yml,line=23,endLine=23,col=19,endColumn=32::Input "config"/,
    );
    // Workflow commands on purpose: not defused like the rest of the output.
    expect(r.stdout).not.toContain('\u200b');
    expect((await flowpact(['lint', '--root', fixture('clean'), '--format', 'github', '-q'])).stdout).toBe(
      '',
    );
  });

  it('resolves paths against the repository in GitHub Actions when --root is a subdirectory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowpact-workspace-'));
    const r = await flowpact(
      [
        'lint',
        '--root',
        fixture('incident-matrix'),
        '--format',
        'github',
        '-q',
        '-o',
        join(dir, 'r.sarif'),
        '-o',
        join(dir, 'r.md'),
      ],
      {
        NO_COLOR: '1',
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: ROOT,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_SHA: 'abc123',
      },
    );
    expect(r.stdout).toContain(',file=fixtures/incident-matrix/.github/workflows/tests.yml,');
    expect(readFileSync(join(dir, 'r.sarif'), 'utf8')).toContain(
      '"uri": "fixtures/incident-matrix/.github/workflows/tests.yml"',
    );
    expect(readFileSync(join(dir, 'r.md'), 'utf8')).toContain(
      '(https://github.com/acme/fixtures/blob/abc123/fixtures/incident-matrix/.github/workflows/tests.yml#L23)',
    );
  });

  it('supports the same formats in flowpact check', async () => {
    const r = await flowpact(['check', '--root', fixture('clean'), '--format', 'markdown', '-q']);
    expect(r.stdout).toContain('### Contracts');
  });
});
