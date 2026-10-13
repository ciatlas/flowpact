/**
 * The API as a consumer gets it: the built package, imported by its name through `exports` from a project's
 * node_modules, in a Node process of its own (the bundle runs under Node, not the test runner's module loader). Where
 * the CLI prints the same thing, the two are compared.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportSchema, VERSION } from '@flowpact/lint';
import { build } from 'esbuild';
import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PKG = join(ROOT, 'packages/cli');
const BIN = join(PKG, 'dist/index.js');
const fixture = (name: string) => join(ROOT, 'fixtures', name);
const require = createRequire(import.meta.url);

/** The environment of every process: no color, debug or CI settings inherited from the one running the tests. */
const ENV = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  NO_COLOR: '1',
  GITHUB_REPOSITORY: 'acme/fixtures',
};

/** A project that depends on flowpact: node_modules/flowpact is the package directory, as `npm install` links it. */
let consumer: string;
let scripts = 0;

beforeAll(() => {
  consumer = mkdtempSync(join(tmpdir(), 'flowpact-api-'));
  mkdirSync(join(consumer, 'node_modules'));
  symlinkSync(PKG, join(consumer, 'node_modules/flowpact'), 'junction');
  writeFileSync(join(consumer, 'package.json'), '{ "private": true, "type": "module" }\n');
});

const PRELUDE = `import * as flowpact from 'flowpact';
const out = (value) => process.stdout.write(JSON.stringify(value));
const failure = async (promise) => {
  try {
    await promise;
    return null;
  } catch (e) {
    return { isFlowpactError: e instanceof flowpact.FlowpactError, name: e.name, kind: e.kind, message: e.message, file: e.file, issues: e.issues, cause: Boolean(e.cause) };
  }
};
`;

/**
 * Runs `code` as a module of the consumer, after a prelude that imports the package as `flowpact`, and returns what it
 * passes to `out()`. Nothing else may reach stdout or stderr: the API prints nothing.
 */
async function api<T = Record<string, unknown>>(code: string, env: Record<string, string> = {}): Promise<T> {
  const file = join(consumer, `script-${scripts++}.mjs`);
  writeFileSync(file, `${PRELUDE}${code}\n`);
  const r = await execa('node', [file], {
    cwd: consumer,
    reject: false,
    extendEnv: false,
    env: { ...ENV, ...env },
  });
  if (r.exitCode !== 0 || r.stderr) throw new Error(`exit ${r.exitCode}\n${r.stderr}\n${r.stdout}`);
  return JSON.parse(r.stdout) as T;
}

/** The CLI's output for the same request. */
async function cli(args: string[], env: Record<string, string> = {}) {
  const r = await execa('node', [BIN, ...args, '-q'], {
    cwd: consumer,
    reject: false,
    extendEnv: false,
    env: { ...ENV, ...env },
  });
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

/** Timings differ between runs. */
/** Output without its timings. In the terminal summary box, the padding after them depends on their width too. */
const untimed = (s: string) =>
  s.replace(/\d+ ms\b */g, 'N ms ').replace(/"durationMs": \d+/g, '"durationMs": 0');

function copy(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'flowpact-api-repo-'));
  cpSync(fixture(name), root, { recursive: true });
  return root;
}

function write(root: string, files: Record<string, string>) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
}

const plugin = (code: string, name: string) =>
  `export default { code: '${code}', name: '${name}', category: 'structure', defaultSeverity: 'error',
  docsUrl: 'https://example.com/${code}', docs: { summary: 'A plugin rule.', why: 'Why.', fix: 'Fix.' },
  check(ctx) { ctx.report({ message: '${name} ran', loc: { file: '.github/workflows/a.yml', line: 1, column: 1, endLine: 1, endColumn: 2 } }); } };\n`;

/** A repository whose config lists a plugin, an organization's plugin and base config elsewhere. */
function pluginRepo() {
  const root = mkdtempSync(join(tmpdir(), 'flowpact-api-plugins-'));
  write(root, {
    '.github/workflows/a.yml': 'on: push\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    'repo.mjs': plugin('REPO601', 'repo-rule'),
    '.github/flowpact/flowpact.config.yml': 'plugins: [./repo.mjs]\n',
  });
  const org = mkdtempSync(join(tmpdir(), 'flowpact-api-org-'));
  write(org, {
    'rules/acme.mjs': plugin('ACME601', 'acme-rule'),
    'acme.base.yml': 'rules:\n  acme-rule: warning\n  repo-rule: info\n',
    'invalid.mjs': plugin('FP601', 'not-ours'),
  });
  return { root, org };
}

describe('the package', () => {
  it('resolves to dist/api.js through its exports, with one function per command', async () => {
    const r = await api<{ keys: string[]; types: string[]; version: string; resolved: string }>(`
      const keys = Object.keys(flowpact).sort();
      out({ keys, types: keys.map((k) => typeof flowpact[k]), version: flowpact.VERSION, resolved: import.meta.resolve('flowpact') });`);
    expect(r.keys).toEqual([
      'FlowpactError',
      'VERSION',
      'check',
      'defineRule',
      'explain',
      'formatExplain',
      'formatGeneration',
      'formatGraph',
      'formatRules',
      'formatTrace',
      'generate',
      'graph',
      'impact',
      'lint',
      'rules',
      'terminalOptions',
      'trace',
    ]);
    expect(r.types).toEqual(['function', 'string', ...Array.from({ length: 15 }, () => 'function')]);
    expect(r.version).toBe(VERSION);
    expect(fileURLToPath(r.resolved)).toBe(realpathSync(join(PKG, 'dist/api.js')));
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
    expect(pkg.bin).toEqual({ flowpact: 'dist/index.js' });
  });
});

describe('lint', () => {
  it('returns the report and every format the CLI prints, without printing anything', async () => {
    const root = fixture('incident-matrix');
    const r = await api<{
      report: unknown;
      json: string;
      sarif: string;
      markdown: string;
      pretty: string;
      ascii: string;
      github: string;
      githubPrefixed: string;
      annotations: { level: string; title: string; file: string; startLine: number }[];
      prefixed: string[];
      exit: number[];
      notes: string[];
      contracts: unknown;
      impact: unknown;
      exitCodeAfter: unknown;
    }>(`
      const a = await flowpact.lint({ root: ${JSON.stringify(root)} });
      out({
        report: a.report, json: a.json(), sarif: a.sarif(), markdown: a.markdown(), pretty: a.pretty(),
        ascii: a.pretty({ ascii: true, hideInfo: true, width: 80 }), annotations: a.annotations(),
        github: a.github(), githubPrefixed: a.github({ pathPrefix: 'sub' }),
        prefixed: a.annotations({ pathPrefix: 'sub' }).map((x) => x.file),
        exit: [a.exitCode(), a.exitCode('error'), a.exitCode('warning'), a.exitCode('never')],
        notes: a.notes, contracts: a.contracts ?? null, impact: a.impact ?? null, exitCodeAfter: process.exitCode ?? null,
      });`);
    expect(reportSchema.safeParse(r.report).success).toBe(true);
    expect(r.report).toEqual(JSON.parse(r.json));
    expect(r.exit).toEqual([1, 1, 1, 0]);
    expect(r).toMatchObject({ notes: [], contracts: null, impact: null, exitCodeAfter: null });
    // The CLI prints the same reports (it is built on these functions).
    const json = await cli(['lint', '--root', root, '--format', 'json']);
    expect(json.code).toBe(1);
    expect(untimed(json.stdout)).toBe(untimed(r.json).trimEnd());
    expect((await cli(['lint', '--root', root, '--format', 'sarif'])).stdout).toBe(r.sarif.trimEnd());
    expect(untimed((await cli(['lint', '--root', root, '--format', 'markdown'])).stdout)).toBe(
      untimed(r.markdown).trimEnd(),
    );
    expect(untimed((await cli(['lint', '--root', root])).stdout)).toBe(untimed(r.pretty).trimEnd());
    expect(r.ascii).not.toMatch(/[✖▲●│]/);
    expect(r.pretty).not.toMatch(/\u001B\[/);
    const github = (await cli(['lint', '--root', root, '--format', 'github'])).stdout;
    expect(r.github).toBe(`${github}\n`);
    const lines = github.split('\n');
    expect(lines).toHaveLength(r.annotations.length);
    r.annotations.forEach((a, i) => {
      expect(lines[i]).toContain(`::${a.level} title=${a.title},file=${a.file},line=${a.startLine},`);
    });
    expect(r.githubPrefixed.split('\n')[0]).toContain(',file=sub/.github/workflows/');
    expect(r.prefixed.every((f) => f.startsWith('sub/.github/workflows/'))).toBe(true);
  });

  it('takes the flags as options and logs only when asked', async () => {
    const root = fixture('incident-matrix');
    const r = await api<{
      files: string[];
      only: string[];
      logged: string[];
      levels: string[];
      quiet: number;
    }>(`
      const records = [];
      const scoped = await flowpact.lint({ root: ${JSON.stringify(root)}, paths: ['.github/workflows/tests.yml'], schema: false });
      const only = await flowpact.lint({ root: ${JSON.stringify(root)}, only: ['FP401'], log: { level: 'debug', write: (r) => records.push(r) } });
      const quiet = await flowpact.lint({ root: ${JSON.stringify(root)}, log: { level: 'error', write: (r) => records.push(r) } });
      out({
        files: [...new Set(scoped.report.findings.map((f) => f.loc.file))],
        only: [...new Set(only.report.findings.map((f) => f.code))],
        logged: records.map((r) => r.message),
        levels: [...new Set(records.map((r) => r.level))].sort(),
        quiet: quiet.report.findings.length,
      });`);
    expect(r.files).toEqual(['.github/workflows/tests.yml']);
    expect(r.only).toEqual(['FP401']);
    expect(r.logged.some((m) => m.startsWith('analysis finished'))).toBe(true);
    expect(r.logged.some((m) => m.startsWith('matrix expanded'))).toBe(true);
    expect(r.levels).toEqual(['debug', 'info']);
    expect(r.quiet).toBeGreaterThan(0);
  });
});

describe('check', () => {
  it('compares the locked contracts and gives the patch the CLI writes', async () => {
    const root = fixture('contracts-drift');
    const r = await api<{
      contracts: { drift: boolean; breaking: number };
      patch: string;
      report: boolean;
      exit: number;
    }>(`
      const a = await flowpact.check({ root: ${JSON.stringify(root)} });
      out({ contracts: a.contracts, patch: a.contracts.patch(), report: a.report.contracts.drift, exit: a.exitCode() });`);
    expect(r.contracts.drift).toBe(true);
    expect(r.contracts.breaking).toBeGreaterThan(0);
    expect(r).toMatchObject({ report: true, exit: 1 });
    const patch = join(mkdtempSync(join(tmpdir(), 'flowpact-api-patch-')), 'contracts.patch');
    await cli(['check', '--root', root, '--patch', patch]);
    expect(r.patch).toBe(readFileSync(patch, 'utf8'));
    expect(r.patch.startsWith('diff --git ')).toBe(true);
  });
});

describe('generate', () => {
  it('previews, writes, and leaves nothing for check to report', async () => {
    const root = copy('clean');
    const out = mkdtempSync(join(tmpdir(), 'flowpact-api-out-'));
    const r = await api<{
      preview: { drift: boolean; written: string[]; counts: Record<string, number>; patch: string };
      before: boolean;
      written: string[];
      drift: boolean;
      again: { drift: boolean; patch: null };
      elsewhere: string[];
    }>(`
      import { existsSync } from 'node:fs';
      const root = ${JSON.stringify(root)};
      const preview = await flowpact.generate({ root, dryRun: true });
      const before = existsSync(root + '/.github/flowpact');
      const written = await flowpact.generate({ root });
      const after = await flowpact.check({ root });
      const again = await flowpact.generate({ root, dryRun: true });
      const elsewhere = await flowpact.generate({ root, out: ${JSON.stringify(out)} });
      out({
        preview: { drift: preview.drift, written: preview.written, counts: preview.counts, patch: preview.patch() },
        before, written: written.written, drift: after.contracts.drift,
        again: { drift: again.drift, patch: again.patch() ?? null }, elsewhere: elsewhere.written,
      });`);
    expect(r.preview).toMatchObject({
      drift: true,
      written: [],
      counts: { create: 3, update: 0, delete: 0 },
    });
    expect(r.preview.patch).toContain('new file mode 100644');
    expect(r.before).toBe(false);
    expect(r.written.sort()).toEqual([
      '.github/flowpact/contracts/actions/setup-node.contract.yml',
      '.github/flowpact/contracts/workflows/ci.contract.yml',
      '.github/flowpact/contracts/workflows/test.contract.yml',
    ]);
    expect(r.drift).toBe(false);
    expect(r.again).toEqual({ drift: false, patch: null });
    expect(r.elsewhere).toHaveLength(3);
    expect(existsSync(join(out, '.github/flowpact/contracts/workflows/ci.contract.yml'))).toBe(true);
  });
});

describe('graph, trace, rules and explain', () => {
  it('return what the CLI prints as JSON', async () => {
    const deep = fixture('deep-nesting');
    const incident = fixture('incident-matrix');
    const r = await api<{
      graph: unknown;
      down: unknown;
      up: unknown;
      plain: unknown;
      rules: unknown;
      explain: Record<string, unknown>;
      byName: string;
    }>(`
      out({
        graph: await flowpact.graph({ root: ${JSON.stringify(deep)} }),
        down: await flowpact.trace({ root: ${JSON.stringify(incident)}, symbol: 'tests.yml#inputs.suite' }),
        up: await flowpact.trace({ root: ${JSON.stringify(incident)}, symbol: 'run-suite.yml:config', up: true, depth: 3 }),
        plain: await flowpact.trace({ root: ${JSON.stringify(fixture('clean'))}, symbol: 'ci.yml' }),
        rules: await flowpact.rules(),
        explain: await flowpact.explain('FP401'),
        byName: (await flowpact.explain('empty-binding-for-matrix-combo')).code,
      });`);
    const json = async (args: string[]) => JSON.parse((await cli([...args, '--format', 'json'])).stdout);
    expect(r.graph).toEqual(await json(['graph', '--root', deep]));
    expect(r.down).toEqual(await json(['trace', 'tests.yml#inputs.suite', '--root', incident]));
    expect(r.up).toEqual(
      await json(['trace', 'run-suite.yml:config', '--up', '--depth', '3', '--root', incident]),
    );
    expect(r.plain).toEqual({
      query: 'ci.yml',
      direction: 'down',
      traces: [],
      unit: '.github/workflows/ci.yml',
    });
    expect(r.rules).toEqual(await json(['rules']));
    expect(r.explain).toMatchObject({
      code: 'FP401',
      name: 'empty-binding-for-matrix-combo',
      category: 'matrix',
      severity: r.explain.defaultSeverity,
      docsUrl: 'https://ciatlas.github.io/flowpact/docs/rules/fp401',
      generatedFiles: 'report',
    });
    expect(r.explain).toHaveProperty('why');
    expect(r.explain).toHaveProperty('examples.bad');
    expect(r.byName).toBe('FP401');
  });
});

describe('text', () => {
  it('is what each command prints, from what the functions return', async () => {
    const deep = fixture('deep-nesting');
    const incident = fixture('incident-matrix');
    const r = await api<
      Record<
        | 'tree'
        | 'mermaid'
        | 'dot'
        | 'asciiTree'
        | 'down'
        | 'up'
        | 'plain'
        | 'plainAscii'
        | 'rules'
        | 'narrow'
        | 'explain'
        | 'colored',
        string
      >
    >(`
      const g = await flowpact.graph({ root: ${JSON.stringify(deep)} });
      const down = await flowpact.trace({ root: ${JSON.stringify(incident)}, symbol: 'tests.yml#inputs.suite' });
      const up = await flowpact.trace({ root: ${JSON.stringify(incident)}, symbol: 'run-suite.yml:config', up: true, depth: 3 });
      const plain = await flowpact.trace({ root: ${JSON.stringify(fixture('clean'))}, symbol: 'ci.yml' });
      out({
        tree: flowpact.formatGraph(g), mermaid: flowpact.formatGraph(g, { format: 'mermaid' }),
        dot: flowpact.formatGraph(g, { format: 'dot' }), asciiTree: flowpact.formatGraph(g, { ascii: true }),
        down: flowpact.formatTrace(down), up: flowpact.formatTrace(up), plain: flowpact.formatTrace(plain),
        plainAscii: flowpact.formatTrace(plain, { ascii: true }),
        rules: flowpact.formatRules(await flowpact.rules()), narrow: flowpact.formatRules(await flowpact.rules(), { width: 60 }),
        explain: flowpact.formatExplain(await flowpact.explain('FP401')),
        colored: flowpact.formatExplain(await flowpact.explain('FP401'), { color: true, hyperlinks: true }),
      });`);
    const cliOut = async (args: string[], env: Record<string, string> = {}) => (await cli(args, env)).stdout;
    expect(r.tree).toBe(await cliOut(['graph', '--root', deep]));
    expect(r.mermaid.trimEnd()).toBe(await cliOut(['graph', '--root', deep, '--format', 'mermaid']));
    expect(r.dot.trimEnd()).toBe(await cliOut(['graph', '--root', deep, '--format', 'dot']));
    expect(r.asciiTree).toBe(await cliOut(['graph', '--root', deep, '--ascii']));
    expect(r.down).toBe(await cliOut(['trace', 'tests.yml#inputs.suite', '--root', incident]));
    expect(r.up).toBe(
      await cliOut(['trace', 'run-suite.yml:config', '--up', '--depth', '3', '--root', incident]),
    );
    expect(r.plain).toBe(await cliOut(['trace', 'ci.yml', '--root', fixture('clean')]));
    expect(r.plain).toBe(
      '.github/workflows/ci.yml declares no inputs, secrets or outputs — nothing to trace.',
    );
    expect(r.plainAscii).not.toContain('—');
    expect(r.rules).toBe(await cliOut(['rules']));
    expect(r.narrow).toBe(await cliOut(['rules'], { COLUMNS: '60' }));
    expect(r.explain).toBe(await cliOut(['explain', 'FP401']));
    expect(r.colored).toMatch(/\u001B\[/);
    expect(r.colored).toContain('\u001B]8;;https://ciatlas.github.io/flowpact/docs/rules/fp401');
    expect(r.tree).not.toMatch(/\u001B/);
  });

  it('is what generate prints, previewed, with its diff, and written', async () => {
    const [mine, theirs] = [copy('clean'), copy('clean')];
    const r = await api<Record<'preview' | 'diff' | 'written' | 'current', string>>(`
      const root = ${JSON.stringify(mine)};
      const preview = await flowpact.generate({ root, dryRun: true });
      out({
        preview: flowpact.formatGeneration(preview),
        diff: flowpact.formatGeneration(preview, { diff: true }),
        written: flowpact.formatGeneration(await flowpact.generate({ root })),
        current: flowpact.formatGeneration(await flowpact.generate({ root, dryRun: true }), { diff: true }),
      });`);
    const patch = join(mkdtempSync(join(tmpdir(), 'flowpact-api-patch-')), 'contracts.patch');
    const cliOut = async (args: string[]) => (await cli(['generate', '--root', theirs, ...args])).stdout;
    expect(r.diff.trimEnd()).toBe(await cliOut(['--dry-run']));
    expect(r.preview).toBe(await cliOut(['--patch', patch]));
    expect(r.written).toBe(await cliOut([]));
    expect(r.current).toBe(await cliOut(['--dry-run']));
    expect(r.preview).toContain('Would write: 3 new');
    expect(r.diff.startsWith(r.preview)).toBe(true);
    expect(r.diff).toContain('new file mode 100644');
    expect(r.written).toContain('Wrote: 3 new');
    expect(r.current).toContain('Contracts are up to date');
  });

  it('says what a run wrote even when nothing was, as with only deletions under out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-api-out-del-'));
    const job = 'on: push\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n';
    // b.yml gets a contract and goes; a.yml has a YAML error, so its (missing) contract is left alone.
    write(root, { '.github/workflows/a.yml': 'on: [push\njobs:\n', '.github/workflows/b.yml': job });
    await cli(['generate', '--root', root]);
    rmSync(join(root, '.github/workflows/b.yml'));
    // Out of the repository, a removed contract is not written anywhere: `written` is empty, but the run wrote.
    const [mine, theirs] = [
      mkdtempSync(join(tmpdir(), 'flowpact-api-out-')),
      mkdtempSync(join(tmpdir(), 'flowpact-api-out-')),
    ];
    const r = await api<{ text: string; dryRun: boolean; written: string[]; preview: boolean }>(`
      const g = await flowpact.generate({ root: ${JSON.stringify(root)}, out: ${JSON.stringify(mine)} });
      out({ text: flowpact.formatGeneration(g), dryRun: g.dryRun, written: g.written,
        preview: (await flowpact.generate({ root: ${JSON.stringify(root)}, dryRun: true })).dryRun });`);
    expect(r).toMatchObject({ dryRun: false, written: [], preview: true });
    expect(r.text).toContain('Wrote: 0 new, 0 changed, 1 removed');
    expect(r.text).toBe((await cli(['generate', '--root', root, '--out', theirs])).stdout);
  });

  it('renders JSON saved from the CLI, checks its options, and follows the terminal like the CLI', async () => {
    const deep = fixture('deep-nesting');
    const saved = join(mkdtempSync(join(tmpdir(), 'flowpact-api-graph-')), 'graph.json');
    writeFileSync(saved, (await cli(['graph', '--root', deep, '--format', 'json'])).stdout);
    const script = `
      import { readFileSync } from 'node:fs';
      const g = await flowpact.graph({ root: ${JSON.stringify(deep)} });
      out({
        same: flowpact.formatGraph(JSON.parse(readFileSync(${JSON.stringify(saved)}, 'utf8'))) === flowpact.formatGraph(g),
        format: await failure(Promise.resolve().then(() => flowpact.formatGraph(g, { format: 'svg' }))),
        width: await failure(Promise.resolve().then(() => flowpact.formatRules([], { width: 0 }))),
        terminal: flowpact.terminalOptions(),
      });`;
    const r = await api<{
      same: boolean;
      format: { kind: string; message: string };
      width: { kind: string; message: string };
      terminal: Record<string, unknown>;
    }>(script);
    expect(r.same).toBe(true);
    expect(r.format).toMatchObject({
      kind: 'usage',
      message: 'format must be one of tree, mermaid, dot (got "svg")',
    });
    expect(r.width).toMatchObject({ kind: 'usage', message: 'width must be a positive integer (got 0)' });
    // Not a terminal, NO_COLOR set: what the CLI uses when its output is piped.
    expect(r.terminal).toEqual({ color: false, width: 100, hyperlinks: false, ascii: false });
    // COLUMNS set by hand to a fraction: whole columns, which every format function accepts.
    const fraction = await api<{ terminal: Record<string, unknown> }>(script, { COLUMNS: '80.5' });
    expect(fraction.terminal).toMatchObject({ width: 80 });
    expect((await cli(['lint', '--root', fixture('clean')], { COLUMNS: '80.5' })).code).toBe(0);
    const forced = await api<{ terminal: Record<string, unknown> }>(script, {
      NO_COLOR: '',
      FORCE_COLOR: '1',
      COLUMNS: '60',
    });
    expect(forced.terminal).toEqual({ color: true, width: 60, hyperlinks: false, ascii: false });
  });

  it('never has a line that GitHub would run as a workflow command, like the CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-api-cmd-'));
    write(root, {
      '.github/workflows/w.yml': `name: "##[error]pwned"\non:\n  workflow_call:\n    inputs:\n      "${'a'.repeat(70)} ::error title=wrap::pwned": { type: string }\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n`,
      '.github/workflows/caller.yml': 'on: push\njobs:\n  call:\n    uses: ./.github/workflows/w.yml\n',
    });
    const r = await api<
      Record<'pretty' | 'narrow' | 'markdown' | 'tree' | 'mermaid' | 'dot' | 'trace', string>
    >(`
      const root = ${JSON.stringify(root)};
      const a = await flowpact.lint({ root });
      const g = await flowpact.graph({ root });
      out({
        pretty: a.pretty(), narrow: a.pretty({ width: 40 }), markdown: a.markdown(),
        tree: flowpact.formatGraph(g), mermaid: flowpact.formatGraph(g, { format: 'mermaid' }),
        dot: flowpact.formatGraph(g, { format: 'dot' }),
        trace: flowpact.formatTrace(await flowpact.trace({ root, symbol: 'w.yml' })),
      });`);
    expect(r.pretty).toContain('pwned');
    expect(r.tree).toContain('pwned');
    for (const [name, text] of Object.entries(r)) {
      expect(text, name).not.toMatch(/^\s*::/m);
      expect(text, name).not.toContain('##[');
    }
    expect(untimed(r.pretty)).toBe(untimed((await cli(['lint', '--root', root])).stdout));
  });
});

describe('impact', () => {
  const reusable = (name: string) =>
    `on:\n  workflow_call:\n    inputs:\n      node: { type: string, default: '22' }\njobs:\n  test:\n    name: ${name}\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n`;

  /** A repository whose branch renames the check of a published reusable workflow: a major change. */
  function renamed(): string {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-api-impact-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    write(root, { '.github/workflows/ci-reusable.yml': reusable('Test') });
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'change');
    write(root, { '.github/workflows/ci-reusable.yml': reusable('Unit tests') });
    git('commit', '-q', '-am', 'change');
    return root;
  }

  it('judges the declared impact, also as part of lint, and is skipped on merge_group', async () => {
    const root = renamed();
    const r = await api<{
      fix: {
        impact: { required: string; ok: boolean; declared: { level: string } };
        exit: number;
        codes: string[];
      };
      bang: { ok: boolean; exit: number };
      lint: { ok: boolean; declared: string };
    }>(`
      const root = ${JSON.stringify(root)};
      const fix = await flowpact.impact({ root, base: 'main', title: 'fix: tidy the test job' });
      const bang = await flowpact.impact({ root, base: 'main', expect: 'major' });
      const lint = await flowpact.lint({ root, impact: true, base: 'main', expect: 'major' });
      out({
        fix: { impact: fix.impact, exit: fix.exitCode(), codes: fix.report.findings.map((f) => f.code) },
        bang: { ok: bang.impact.ok, exit: bang.exitCode() },
        lint: { ok: lint.report.impact.ok, declared: lint.impact.declared.kind },
      });`);
    expect(r.fix.impact).toMatchObject({ required: 'major', ok: false, declared: { level: 'patch' } });
    expect(r.fix.exit).toBe(1);
    expect(r.fix.codes).toContain('FP810');
    expect(r.bang).toEqual({ ok: true, exit: 0 });
    expect(r.lint).toEqual({ ok: true, declared: 'explicit' });

    const skipped = await api<{ notes: string[]; impact: null; exit: number; findings: number }>(
      `const a = await flowpact.impact({ root: ${JSON.stringify(root)} });
      out({ notes: a.notes, impact: a.impact ?? null, exit: a.exitCode(), findings: a.report.findings.length });`,
      { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'merge_group' },
    );
    expect(skipped).toEqual({
      notes: ['impact: skipped (merge_group: impact was checked on the pull request)'],
      impact: null,
      exit: 0,
      findings: 0,
    });
  });

  it('grades only the published units within paths, in impact() and lint({ impact })', async () => {
    const root = renamed();
    write(root, {
      '.github/workflows/ci.yml': 'on: push\njobs:\n  t:\n    runs-on: x\n    steps: [{ run: x }]\n',
    });
    type Run = { impact: { required: string; ok: boolean; scope?: unknown }; exit: number };
    const r = await api<Record<'ci' | 'reusable' | 'lint' | 'all', Run>>(`
      const root = ${JSON.stringify(root)};
      const of = (a) => ({ impact: a.impact, exit: a.exitCode() });
      out({
        ci: of(await flowpact.impact({ root, base: 'main', expect: 'patch', paths: ['.github/workflows/ci.yml'] })),
        reusable: of(await flowpact.impact({ root, base: 'main', expect: 'patch', paths: ['.github/workflows/ci-reusable.yml'] })),
        lint: of(await flowpact.lint({ root, impact: true, base: 'main', expect: 'patch', paths: ['.github/workflows/ci.yml'] })),
        all: of(await flowpact.impact({ root, base: 'main', expect: 'patch' })),
      });`);
    expect(r.ci).toEqual({
      impact: expect.objectContaining({
        required: 'none',
        ok: true,
        scope: { paths: ['.github/workflows/ci.yml'], units: [] },
      }),
      exit: 0,
    });
    expect(r.reusable).toMatchObject({
      impact: { required: 'major', ok: false, scope: { units: ['.github/workflows/ci-reusable.yml'] } },
      exit: 1,
    });
    expect(r.lint).toMatchObject({ impact: { required: 'none', ok: true }, exit: 0 });
    expect(r.all).toMatchObject({ impact: { required: 'major', ok: false }, exit: 1 });
    expect(r.all.impact.scope).toBeUndefined();
    const cliReport = await cli([
      'impact',
      '.github/workflows/ci.yml',
      '--root',
      root,
      '--base',
      'main',
      '--expect',
      'patch',
      '--format',
      'json',
    ]);
    expect(r.ci.impact).toEqual(JSON.parse(cliReport.stdout).impact);
  });
});

describe('plugins and base config', () => {
  it('loads the repository’s plugins unless told not to, extra plugins always, under the base config', async () => {
    const { root, org } = pluginRepo();
    const r = await api<Record<string, [string, string][]>>(`
      const root = ${JSON.stringify(root)};
      const found = (a) => a.report.findings.map((f) => [f.code, f.severity]);
      out({
        repository: found(await flowpact.lint({ root })),
        untrusted: found(await flowpact.lint({ root, repositoryPlugins: false })),
        organization: found(await flowpact.lint({
          root, repositoryPlugins: false, plugins: [${JSON.stringify(join(org, 'rules/acme.mjs'))}],
          baseConfig: ${JSON.stringify(join(org, 'acme.base.yml'))},
        })),
        both: found(await flowpact.lint({
          root, plugins: [${JSON.stringify(join(org, 'rules/acme.mjs'))}], baseConfig: ${JSON.stringify(join(org, 'acme.base.yml'))},
        })),
        rules: (await flowpact.rules({ root, plugins: [${JSON.stringify(join(org, 'rules/acme.mjs'))}], baseConfig: ${JSON.stringify(join(org, 'acme.base.yml'))} }))
          .filter((x) => !x.code.startsWith('FP')).map((x) => [x.code, x.severity]),
      });`);
    expect(r.repository).toEqual([['REPO601', 'error']]);
    expect(r.untrusted).toEqual([]);
    expect(r.organization).toEqual([['ACME601', 'warning']]);
    expect(r.both).toEqual([
      ['ACME601', 'warning'],
      ['REPO601', 'info'],
    ]);
    expect(r.rules).toEqual([
      ['ACME601', 'warning'],
      ['REPO601', 'info'],
    ]);
  });

  it('gives a rule typed with defineRule back as it is', async () => {
    const r = await api<{ same: boolean }>(`
      const rule = { code: 'ACME601', name: 'x', category: 'structure', defaultSeverity: 'error', docs: {}, check() {} };
      out({ same: flowpact.defineRule(rule) === rule });`);
    expect(r.same).toBe(true);
  });
});

describe('errors', () => {
  it('are FlowpactErrors with the kind of problem, the file and the issues', async () => {
    const { root, org } = pluginRepo();
    const bad = mkdtempSync(join(tmpdir(), 'flowpact-api-bad-'));
    write(bad, {
      '.github/workflows/a.yml': 'on: push\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
      '.github/flowpact/flowpact.config.yml': 'rules:\n  unused-inptu: error\n',
      'plugins.base.yml': 'plugins: [x.mjs]\n',
      'invalid.yml': 'rules: {}\nignored: [x]\n',
    });
    const linked = copy('clean');
    const outside = mkdtempSync(join(tmpdir(), 'flowpact-api-outside-'));
    mkdirSync(join(linked, '.github/flowpact/contracts/workflows'), { recursive: true });
    symlinkSync(join(outside, 'x'), join(linked, '.github/flowpact/contracts/workflows/ci.contract.yml'));
    const empty = mkdtempSync(join(tmpdir(), 'flowpact-api-empty-'));
    const r = await api<Record<string, Record<string, unknown> | null>>(`
      const clean = ${JSON.stringify(fixture('clean'))};
      out({
        config: await failure(flowpact.lint({ root: ${JSON.stringify(bad)}, config: ${JSON.stringify(join(bad, 'invalid.yml'))} })),
        typo: await failure(flowpact.lint({ root: ${JSON.stringify(bad)} })),
        base: await failure(flowpact.rules({ root: ${JSON.stringify(bad)}, baseConfig: ${JSON.stringify(join(bad, 'plugins.base.yml'))} })),
        missingPlugin: await failure(flowpact.lint({ root: clean, plugins: ['no-such-plugin.mjs'] })),
        invalidPlugin: await failure(flowpact.lint({ root: ${JSON.stringify(root)}, plugins: [${JSON.stringify(join(org, 'invalid.mjs'))}] })),
        unsafe: await failure(flowpact.generate({ root: ${JSON.stringify(linked)} })),
        impactSetup: await failure(flowpact.impact({ root: clean, base: 'no-such-ref' })),
        empty: await failure(flowpact.lint({ root: ${JSON.stringify(empty)} })),
        missingPath: await failure(flowpact.lint({ root: clean, paths: ['nope.yml'] })),
        notAList: await failure(flowpact.lint({ root: clean, paths: 'ci.yml' })),
        // What @actions/core getInput returns: refused, not read as true (which would run the repository's plugins).
        stringBool: await failure(flowpact.lint({ root: ${JSON.stringify(root)}, repositoryPlugins: 'false' })),
        unknownRule: await failure(flowpact.explain('FP999')),
        unknownOnly: await failure(flowpact.lint({ root: clean, only: ['FP999'] })),
        noSymbol: await failure(flowpact.trace({ root: clean, symbol: 'nope.yml:x' })),
        depth: await failure(flowpact.trace({ root: clean, symbol: 'test.yml', depth: 0 })),
        failOn: await failure(flowpact.lint({ root: clean }).then((a) => a.exitCode('sometimes'))),
        ok: await failure(flowpact.lint({ root: clean })),
      });`);
    expect(r.config).toMatchObject({
      isFlowpactError: true,
      name: 'FlowpactError',
      kind: 'config',
      file: 'invalid.yml',
      cause: true,
    });
    expect(r.config?.issues).toEqual([expect.stringContaining('ignored')]);
    expect(r.typo).toMatchObject({
      kind: 'config',
      issues: [expect.stringContaining('did you mean unused-input?')],
    });
    expect(r.base).toMatchObject({ kind: 'config' });
    // Relative to the working directory, like --plugin.
    expect(r.missingPlugin).toMatchObject({
      kind: 'plugin',
      message: `Plugin not found: ${join(realpathSync(consumer), 'no-such-plugin.mjs')}`,
    });
    expect(r.invalidPlugin).toMatchObject({ kind: 'plugin', message: expect.stringContaining('reserved') });
    expect(r.unsafe).toMatchObject({
      kind: 'unsafe-path',
      message: expect.stringContaining('Not writing contracts'),
    });
    expect(existsSync(join(outside, 'x'))).toBe(false);
    expect(r.impactSetup).toMatchObject({ kind: 'impact-setup' });
    expect(r.empty).toMatchObject({ kind: 'usage', message: expect.stringContaining('No workflows found') });
    expect(r.missingPath).toMatchObject({ kind: 'usage', message: expect.stringContaining('nope.yml') });
    expect(r.notAList).toMatchObject({ kind: 'usage', message: 'paths must be an array of strings' });
    expect(r.stringBool).toMatchObject({
      kind: 'usage',
      message: 'repositoryPlugins must be true or false (got "false")',
    });
    // The CLI adds where the list is.
    expect(r.unknownRule).toMatchObject({
      kind: 'usage',
      message: 'Unknown rule "FP999". Did you mean FP609?',
    });
    expect(r.unknownOnly).toMatchObject({ kind: 'config', issues: [expect.stringContaining('FP999')] });
    // The files to trace instead are in the message; issues are for problems.
    expect(r.noSymbol).toMatchObject({
      kind: 'usage',
      message: expect.stringContaining('.github/workflows/test.yml, .github/actions/setup-node'),
      issues: [],
    });
    expect(r.depth).toMatchObject({ kind: 'usage', message: 'depth must be a positive integer (got 0)' });
    expect(r.failOn).toMatchObject({ kind: 'usage', message: expect.stringContaining('failOn') });
    expect(r.ok).toBeNull();
  });
});

describe('in an action bundled by the organization', () => {
  /** An action's entry: lint, with an organization rule shipped as a file next to the bundle. */
  const entry = `import { lint } from 'flowpact';
const [root, rule] = process.argv.slice(2);
const a = await lint({ root, plugins: [rule] });
process.stdout.write(JSON.stringify({ rules: a.report.rules.map((r) => r.code).filter((c) => !c.startsWith('FP')), findings: a.report.findings.map((f) => f.code) }));
`;
  const root = () => {
    const r = mkdtempSync(join(tmpdir(), 'flowpact-api-bundled-'));
    write(r, {
      '.github/workflows/a.yml': 'on: push\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    });
    return r;
  };
  const runBundle = async (file: string) => {
    const rule = join(dirname(file), 'acme.mjs');
    writeFileSync(rule, plugin('ACME601', 'acme-rule'));
    const r = await execa('node', [file, root(), rule], { reject: false, extendEnv: false, env: ENV });
    expect(r.stderr).toBe('');
    return JSON.parse(r.stdout);
  };

  it('loads plugins when bundled with esbuild', async () => {
    writeFileSync(join(consumer, 'action-esbuild.mjs'), entry);
    const outfile = join(consumer, 'dist-esbuild/index.mjs');
    await build({
      entryPoints: [join(consumer, 'action-esbuild.mjs')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    });
    expect(readFileSync(outfile, 'utf8')).not.toContain("from 'flowpact'");
    expect(await runBundle(outfile)).toEqual({ rules: ['ACME601'], findings: ['ACME601'] });
  });

  it('loads plugins when bundled with @vercel/ncc', async () => {
    writeFileSync(join(consumer, 'action-ncc.mjs'), entry);
    const ncc = join(dirname(require.resolve('@vercel/ncc/package.json')), 'dist/ncc/cli.js');
    const built = await execa('node', [ncc, 'build', 'action-ncc.mjs', '-o', 'dist-ncc', '--quiet'], {
      cwd: consumer,
      reject: false,
    });
    expect(built.exitCode, built.stderr).toBe(0);
    // ncc writes index.mjs for an ES module.
    expect(await runBundle(join(consumer, 'dist-ncc/index.mjs'))).toEqual({
      rules: ['ACME601'],
      findings: ['ACME601'],
    });
  }, 120_000);
});

describe('the declarations', () => {
  it('are self-contained and type a consumer written in TypeScript', async () => {
    const dts = readFileSync(join(PKG, 'dist/api.d.ts'), 'utf8');
    expect(dts).toBe(readFileSync(join(PKG, 'api.d.ts'), 'utf8'));
    // Nothing from the engine, a dependency or Node's types: what a consumer installs is all there is.
    expect(dts).not.toMatch(/^\s*import\b|\bfrom\s+['"]|\/\/\/\s*<reference|\bimport\(/m);
    write(consumer, {
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'es2022',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          lib: ['es2022'],
          types: [],
          noEmit: true,
          skipLibCheck: false,
        },
        files: ['consumer.ts'],
      }),
      'consumer.ts': `import {
  type Analysis, type Annotation, check, defineRule, explain, type Finding, FlowpactError, formatExplain,
  formatGeneration, formatGraph, formatRules, formatTrace, generate, graph, impact, lint, type Loc, type Report,
  type RuleContext, rules, type Severity, terminalOptions, type TextOptions, trace, VERSION,
} from 'flowpact';

const log: string[] = [];
const a: Analysis = await lint({ root: '.', paths: ['.github/workflows/ci.yml'], only: ['FP401'], schema: false,
  baseConfig: 'acme.base.yml', plugins: ['rules/acme.mjs'], repositoryPlugins: false,
  log: { level: 'debug', write: (r) => void log.push(r.message) } });
const report: Report = a.report;
const findings: Finding[] = report.findings;
const where: Loc = findings[0]!.loc;
const severity: Severity = findings[0]!.severity;
const annotations: Annotation[] = a.annotations({ pathPrefix: 'sub' });
const code: 0 | 1 = a.exitCode('warning');
const outputs: string[] = [a.json({ includeGraph: true }), a.sarif(), a.markdown({ title: 't', maxFindings: 5 }),
  a.pretty({ color: false, width: 80, ascii: true, hideInfo: true })];
const patch: string | undefined = (await check()).contracts?.patch();
const required = (await impact({ base: 'main', expect: 'patch', title: 'fix: x', labels: ['a'] })).impact?.required;
const graded: string[] | undefined = (await impact({ paths: ['actions/deploy'] })).impact?.scope?.units;
const written: string[] = (await generate({ dryRun: true, out: 'x' })).written;
const preview: boolean = (await generate({ dryRun: true })).dryRun;
const nodes = (await graph()).nodes.map((n) => n.kind);
const traced = (await trace({ symbol: 'ci.yml#inputs.x', up: true, depth: 2 })).traces[0]?.children;
const listed = (await rules({ repositoryPlugins: false })).map((r) => r.severity);
const why: string = (await explain('FP401', { root: '.' })).why;
const options: TextOptions = terminalOptions();
const texts: string[] = [
  a.github({ pathPrefix: 'sub' }),
  formatGraph(await graph(), { format: 'mermaid' }),
  formatTrace(await trace({ symbol: 'ci.yml' }), options),
  formatRules(await rules(), { ...options, ascii: true }),
  formatExplain(await explain('FP401'), { width: 72 }),
  formatGeneration(await generate({ dryRun: true }), { diff: true, color: options.color }),
];
const unit: string | undefined = (await trace({ symbol: 'ci.yml' })).unit;

const rule = defineRule({
  code: 'ACME601', name: 'prod-deploy-needs-approval', category: 'structure', defaultSeverity: 'error',
  docsUrl: 'https://wiki.acme.dev/ci/ACME601',
  docs: { summary: 's', why: 'w', fix: 'f' },
  check(ctx: RuleContext) {
    for (const wf of ctx.index.project.workflows.values()) {
      for (const job of Object.values(wf.jobs)) {
        const deploysProd = job.with.environment?.value === 'production';
        if (deploysProd && !job.needs.some((n) => n.id === 'approve'))
          ctx.report({ message: \`jobs.\${job.id} deploys without approval\`, loc: job.loc, symbol: \`\${wf.path}#jobs.\${job.id}\` });
        if (ctx.matrix(wf, job).combos.length > 256) ctx.report({ message: 'too many', loc: job.loc, severity: 'warning' });
      }
    }
  },
});

try {
  await lint();
} catch (err) {
  if (err instanceof FlowpactError && err.kind === 'config') log.push(err.file ?? '', ...err.issues);
}

// @ts-expect-error: formats are methods of the result, not options
await lint({ format: 'json' });
// @ts-expect-error: a symbol is required
await trace({});
// @ts-expect-error: not a graph format
formatGraph(await graph(), { format: 'svg' });
// @ts-expect-error: not a level
a.exitCode('sometimes');
// @ts-expect-error: the report is read-only
a.report = report;

export { VERSION, code, outputs, patch, required, graded, written, nodes, traced, listed, why, rule, where, severity, annotations, texts, unit, preview };
`,
    });
    const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
    const r = await execa('node', [tsc, '-p', join(consumer, 'tsconfig.json')], { reject: false });
    expect(`${r.stdout}${r.stderr}`).toBe('');
    expect(r.exitCode).toBe(0);
  }, 120_000);
});
