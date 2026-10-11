import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_BASE_URL, reportSchema, VERSION } from '@flowpact/core';
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
];

/** Runs the built CLI with a controlled environment (no inherited color/debug settings). */
const flowpact = (args: string[], env: Record<string, string> = { NO_COLOR: '1' }) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUB.includes(k)));
  return execa('node', [BIN, ...args], {
    reject: false,
    // A hang fails the one call (exit code undefined, with its arguments in the assertion), not the whole test.
    timeout: 45_000,
    cwd: ROOT,
    extendEnv: false,
    env: { ...base, GITHUB_REPOSITORY: 'acme/fixtures', ...env },
  });
};

describe('flowpact lint', () => {
  it('finds the incident, prints the banner to stderr and exits 1', async () => {
    const r = await flowpact(['lint', '--root', fixture('incident-matrix')]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      `flowpact  v${VERSION}  config schema v1 · contract schema v1 · report schema v1 · node v`,
    );
    expect(r.stdout).toContain('FP401 empty-binding-for-matrix-combo');
    expect(r.stdout).toContain('{ name: windows }');
    expect(r.stdout).toContain('https://rumankazi.github.io/flowpact/docs/rules/fp401');
    expect(r.stdout).not.toMatch(/\u001B\[/);
  });

  it('exits 0 on a clean repository', async () => {
    const r = await flowpact(['lint', '--root', fixture('clean')]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No problems found');
  });

  it('emits schema-valid JSON on stdout with --format json', async () => {
    const r = await flowpact([
      'lint',
      '--root',
      fixture('deep-nesting'),
      '--format',
      'json',
      '--include-graph',
    ]);
    const json = JSON.parse(r.stdout);
    expect(reportSchema.safeParse(json).success).toBe(true);
    expect(json.meta).toMatchObject({
      tool: 'flowpact',
      version: VERSION,
      schemas: { config: 1, contract: 1, report: 1 },
    });
    expect(json.summary.errors).toBe(4);
    expect(json.graph.nodes.length).toBeGreaterThan(10);
  });

  it('writes reports to files (.json as JSON, anything else as plain text)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowpact-out-'));
    const r1 = await flowpact([
      'lint',
      '--root',
      fixture('composite-actions'),
      '-o',
      join(dir, 'out/report.json'),
    ]);
    expect(r1.stderr).toContain('report written to');
    expect(
      reportSchema.safeParse(JSON.parse(readFileSync(join(dir, 'out/report.json'), 'utf8'))).success,
    ).toBe(true);
    await flowpact(['lint', '--root', fixture('composite-actions'), '-o', join(dir, 'report.txt')], {
      FORCE_COLOR: '1',
    });
    const txt = readFileSync(join(dir, 'report.txt'), 'utf8');
    expect(txt).toContain('FP102 unknown-input');
    expect(txt).not.toMatch(/\u001B/);
  });

  it('honours --fail-on and --only', async () => {
    const root = fixture('dynamic-matrix');
    expect((await flowpact(['lint', '--root', root, '--only', 'FP402'])).exitCode).toBe(0);
    expect(
      (await flowpact(['lint', '--root', root, '--only', 'FP402', '--fail-on', 'warning'])).exitCode,
    ).toBe(1);
    expect((await flowpact(['lint', '--root', root, '--fail-on', 'never'])).exitCode).toBe(0);
  });

  it('reports on selected paths only', async () => {
    const r = await flowpact([
      'lint',
      '--root',
      fixture('deep-nesting'),
      '--format',
      'json',
      '.github/workflows/publish.yml',
    ]);
    const files = new Set(JSON.parse(r.stdout).findings.map((f: { loc: { file: string } }) => f.loc.file));
    expect([...files]).toEqual(['.github/workflows/publish.yml']);
  });

  it('colors output when forced and logs every stage with --debug', async () => {
    const r = await flowpact(['lint', '--root', fixture('incident-matrix'), '--debug'], { FORCE_COLOR: '1' });
    expect(r.stdout).toMatch(/\u001B\[31m/);
    for (const msg of [
      'cli context',
      'discovered 3 workflow(s)',
      'graph built',
      'matrix expanded',
      'FP401 empty-binding-for-matrix-combo',
      'analysis finished',
    ]) {
      expect(r.stderr).toContain(msg);
    }
  });

  it('enables debug logging from the environment', async () => {
    const r = await flowpact(['lint', '--root', fixture('clean')], { NO_COLOR: '1', FLOWPACT_DEBUG: '1' });
    expect(r.stderr).toContain('debug');
  });

  it('is quiet with -q and writes the graph with --dump-graph', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'flowpact-g-')), 'graph.json');
    const r = await flowpact(['lint', '--root', fixture('clean'), '-q', '--dump-graph', out]);
    expect(r.stderr).toBe('');
    expect(JSON.parse(readFileSync(out, 'utf8')).edges.length).toBeGreaterThan(0);
  });

  it('applies the repository config file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-cfg-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/a.yml'),
      'on:\n  workflow_dispatch:\n    inputs:\n      dead: {}\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    );
    writeFileSync(join(root, '.github/flowpact/flowpact.config.yml'), 'rules:\n  unused-input: error\n');
    const r = await flowpact(['lint', '--root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('config .github/flowpact/flowpact.config.yml');
    writeFileSync(join(root, '.github/flowpact/flowpact.config.yml'), 'rules:\n  unused-inptu: error\n');
    const bad = await flowpact(['lint', '--root', root]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain('Config error');
    expect(bad.stderr).toContain('did you mean unused-input?');
  });

  it('exits 2 when there is nothing to analyze', async () => {
    const r = await flowpact(['lint', '--root', mkdtempSync(join(tmpdir(), 'flowpact-empty-'))]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('No workflows found');
  });
});

describe('flowpact trace', () => {
  it('prints the JSON envelope for a workflow without an interface', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-plain-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/plain.yml'),
      'on: push\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    );
    const r = await flowpact(['trace', 'plain.yml', '--root', root, '-q', '--format', 'json']);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      query: 'plain.yml',
      direction: 'down',
      traces: [],
      unit: '.github/workflows/plain.yml',
    });
  });

  it('never prints a line that GitHub would run as a workflow command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-cmd-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/w.yml'),
      `on:\n  workflow_dispatch:\n    inputs:\n      "${'a'.repeat(70)} ::error title=wrap::pwned": {}\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n`,
    );
    const r = await flowpact(['lint', '--root', root]);
    expect(r.stdout).toContain('pwned');
    expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/^\s*::/m);
    const file = join(root, 'report.txt');
    await flowpact(['lint', '--root', root, '--output', file]);
    expect(readFileSync(file, 'utf8')).not.toMatch(/^\s*::/m);
  });

  it('refuses to write a contract through a symlink, before writing anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-gen-sym-'));
    const outside = mkdtempSync(join(tmpdir(), 'flowpact-gen-out-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, '.github/flowpact/contracts/workflows'), { recursive: true });
    for (const n of ['a', 'ci', 'z'])
      writeFileSync(
        join(root, `.github/workflows/${n}.yml`),
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
      );
    writeFileSync(join(outside, 'victim.txt'), 'keep\n');
    symlinkSync(
      join(outside, 'victim.txt'),
      join(root, '.github/flowpact/contracts/workflows/ci.contract.yml'),
    );
    const r = await flowpact(['generate', '--root', root]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Not writing contracts');
    expect(r.stderr).not.toContain('crashed');
    expect(r.stdout).not.toContain('Wrote');
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(root, '.github/flowpact/contracts/workflows/a.contract.yml'))).toBe(false);
  });

  it('traces down and up', async () => {
    const down = await flowpact([
      'trace',
      'tests.yml#inputs.suite',
      '--root',
      fixture('incident-matrix'),
      '-q',
    ]);
    expect(down.exitCode).toBe(0);
    expect(down.stdout).toContain('.github/workflows/run-suite.yml#inputs.suite');
    const up = await flowpact([
      'trace',
      'run-suite.yml:config',
      '--up',
      '--root',
      fixture('incident-matrix'),
      '-q',
    ]);
    expect(up.stdout).toContain('missing in { name: windows }');
  });

  it('lists the whole interface for a bare workflow and supports JSON', async () => {
    const r = await flowpact([
      'trace',
      'publish.yml',
      '--root',
      fixture('deep-nesting'),
      '-q',
      '--format',
      'json',
    ]);
    const json = JSON.parse(r.stdout);
    expect(json).toMatchObject({ query: 'publish.yml', direction: 'down' });
    expect(json.traces.map((t: { symbol: string }) => t.symbol.split('#')[1])).toEqual([
      'inputs.environment',
      'inputs.channel',
      'inputs.notes',
      'secrets.token',
      'outputs.url',
    ]);
  });

  it('suggests workflows for unknown symbols', async () => {
    const r = await flowpact(['trace', 'nope.yml:x', '--root', fixture('clean'), '-q']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('flowpact trace .github/workflows/test.yml');
    expect(r.stderr).not.toContain('flowpact trace .github/workflows/ci.yml');
  });
});

describe('flowpact explain / rules / --version', () => {
  it('explains a rule by code or name', async () => {
    const r = await flowpact(['explain', 'empty-binding-for-matrix-combo']);
    expect(r.stdout).toContain('FP401');
    expect(r.stdout).toContain('✓ fixed');
    expect((await flowpact(['explain', 'FP999'])).exitCode).toBe(2);
  });

  it('lists rules as text and JSON', async () => {
    expect((await flowpact(['rules'])).stdout).toContain('FP608');
    const json = JSON.parse((await flowpact(['rules', '--format', 'json'])).stdout);
    expect(json.find((r: { code: string }) => r.code === 'FP604')).toMatchObject({
      severity: 'off',
      defaultSeverity: 'off',
    });
  });

  it('prints version and schema versions', async () => {
    const r = await flowpact(['--version']);
    const banner = `flowpact v${VERSION} · config schema v1 · contract schema v1 · report schema v1 · node v`;
    expect(r.stdout.trim().slice(0, banner.length)).toBe(banner);
  });

  it('points --help at the docs, without color codes when piped (#43)', async () => {
    const root = await flowpact(['--help']);
    expect(root.stdout).toContain(`Docs: ${DOCS_BASE_URL}/docs`);
    expect(root.stdout).toContain(`CLI reference: ${DOCS_BASE_URL}/docs/cli`);
    const lint = await flowpact(['lint', '--help']);
    expect(lint.stdout).toContain(`Docs: ${DOCS_BASE_URL}/docs/cli#flowpact-lint`);
    expect(lint.stdout).not.toMatch(/\u001B\[/);
    expect((await flowpact(['generate', '--help'])).stdout).toContain('/docs/cli#flowpact-generate');
  });

  it('is an executable single-file bundle', () => {
    expect(existsSync(BIN)).toBe(true);
    expect(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });
});

describe('plugins in rules / explain', () => {
  it('lists and explains plugin rules and accepts severities for them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-plugin-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/a.yml'),
      'on: push\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    );
    writeFileSync(
      join(root, 'acme.mjs'),
      `export default { code: 'ACME601', name: 'acme-rule', category: 'structure', defaultSeverity: 'error',
        docsUrl: 'https://example.com/acme601', docs: { summary: 'An example plugin rule for tests.', why: 'Because the platform team says so.', fix: 'Do the thing.' },
        check() {} };\n`,
    );
    writeFileSync(
      join(root, '.github/flowpact/flowpact.config.yml'),
      'plugins: [./acme.mjs]\nrules:\n  acme-rule: warning\n',
    );
    const rules = await flowpact(['rules', '--root', root, '--format', 'json']);
    expect(rules.exitCode).toBe(0);
    expect(JSON.parse(rules.stdout).find((r: { code: string }) => r.code === 'ACME601')).toMatchObject({
      severity: 'warning',
    });
    const explain = await flowpact(['explain', 'ACME601', '--root', root]);
    expect(explain.stdout).toContain('https://example.com/acme601');
  });

  it('skips the config plugins with --no-plugins, and loads others with --plugin', async () => {
    const plugin = (code: string, name: string) =>
      `export default { code: '${code}', name: '${name}', category: 'structure', defaultSeverity: 'error',
        docsUrl: 'https://example.com/${code}', docs: { summary: 'A plugin rule for tests.', why: 'Why.', fix: 'Fix.' },
        check(ctx) { ctx.report({ message: '${name} ran', loc: { file: '.github/workflows/a.yml', line: 1, column: 1, endLine: 1, endColumn: 2 } }); } };\n`;
    const root = mkdtempSync(join(tmpdir(), 'flowpact-no-plugins-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/a.yml'),
      'on: push\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    );
    writeFileSync(join(root, 'repo.mjs'), plugin('REPO601', 'repo-rule'));
    writeFileSync(
      join(root, '.github/flowpact/flowpact.config.yml'),
      'plugins: [./repo.mjs]\nrules:\n  repo-rule: warning\n',
    );
    const org = join(mkdtempSync(join(tmpdir(), 'flowpact-org-')), 'org.mjs');
    writeFileSync(org, plugin('ORG601', 'org-rule'));
    const codes = async (...args: string[]) =>
      JSON.parse((await flowpact(['lint', '--root', root, '--format', 'json', '-q', ...args])).stdout)
        .findings.map((f: { code: string }) => f.code)
        .sort();
    expect(await codes()).toEqual(['REPO601']);
    expect(await codes('--no-plugins')).toEqual([]);
    expect(await codes('--no-plugins', '--plugin', org)).toEqual(['ORG601']);
    expect(await codes(`--plugin=${org}`)).toEqual(['ORG601', 'REPO601']);
    const skipped = await flowpact(['lint', '--root', root, '--no-plugins']);
    expect(skipped.exitCode).toBe(0);
    expect(skipped.stderr).toContain('not loading 1 plugin(s) from the config (--no-plugins)');
    const rules = await flowpact([
      'rules',
      '--root',
      root,
      '--no-plugins',
      '--plugin',
      org,
      '--format',
      'json',
    ]);
    expect(rules.exitCode).toBe(0);
    const listed = JSON.parse(rules.stdout).map((r: { code: string }) => r.code);
    expect(listed).toContain('ORG601');
    expect(listed).not.toContain('REPO601');
  });
});

describe('untrusted values', () => {
  it('never reads the value of another flag, such as a pull request title, as --plugin or -o', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-title-'));
    cpSync(fixture('clean'), root, { recursive: true });
    const marker = join(root, 'pwned');
    writeFileSync(
      join(root, 'evil.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default [];\n`,
    );
    for (const title of [`--plugin=${join(root, 'evil.mjs')}`, `-o=${marker}`, `--output=${marker}`]) {
      const r = await flowpact(['lint', '--root', root, '--no-plugins', '--title', title, '-q']);
      expect({ title, exit: r.exitCode, marker: existsSync(marker) }).toEqual({
        title,
        exit: 0,
        marker: false,
      });
    }
  });

  it('keeps --no-plugins in effect whatever the title, and runs even when the title looks like --help', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-title-plugins-'));
    cpSync(fixture('clean'), root, { recursive: true });
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    const marker = join(root, 'pwned');
    writeFileSync(
      join(root, 'repo.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default [];\n`,
    );
    writeFileSync(join(root, '.github/flowpact/flowpact.config.yml'), 'plugins: [./repo.mjs]\n');
    for (const title of ['--', '--help', '--version', '-h']) {
      const r = await flowpact([
        'lint',
        '--root',
        root,
        '--title',
        title,
        '--no-plugins',
        '--format',
        'json',
      ]);
      expect({
        title,
        exit: r.exitCode,
        marker: existsSync(marker),
        report: r.stdout.startsWith('{'),
      }).toEqual({
        title,
        exit: 0,
        marker: false,
        report: true,
      });
    }
    const before = await flowpact(['--no-plugins', 'lint', '--root', root]);
    expect(before.exitCode).toBe(2);
    expect(before.stderr).toContain('Options go after the command');
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps ##[ out of JSON output without changing the data, and writes patches verbatim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-legacy-commands-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    const name = 'a##[set-output name=x]1';
    writeFileSync(
      join(root, '.github/workflows/reusable.yml'),
      `on:\n  workflow_call:\n    inputs:\n      ${JSON.stringify(name)}:\n        type: string\n        description: ${JSON.stringify(`see ${name}`)}\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n`,
    );
    const json = await flowpact(['lint', '--root', root, '--format', 'json', '--no-schema', '-q']);
    expect(json.stdout).not.toContain('##[');
    expect(JSON.stringify(JSON.parse(json.stdout).findings)).toContain(JSON.stringify(name).slice(1, -1));
    const patch = join(root, 'contracts.patch');
    const r = await flowpact(['generate', '--root', root, '--patch', patch, '-q']);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(patch, 'utf8')).toContain(`see ${name}`);
  });

  it('refuses to write contracts with --out through a symlink in the repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-symlink-out-'));
    cpSync(fixture('clean'), root, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'flowpact-outside-dir-'));
    symlinkSync(outside, join(root, 'out'));
    const r = await flowpact(['generate', '--root', root, '--out', join(root, 'out')]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('is a symlink, or links outside');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('counts -v in clusters, and not --verbose=false', async () => {
    const root = fixture('clean');
    const quiet = await flowpact(['lint', '--root', root, '--verbose=false', '-o', '/dev/null']);
    expect(quiet.stderr).not.toContain('debug');
    const loud = await flowpact(['lint', '--root', root, '-vo', '/dev/null']);
    expect(loud.stderr).toContain('debug');
  });

  it('refuses to write a report through a symlink in the repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-symlink-report-'));
    cpSync(fixture('clean'), root, { recursive: true });
    const outside = join(mkdtempSync(join(tmpdir(), 'flowpact-outside-')), 'target.txt');
    writeFileSync(outside, 'keep');
    symlinkSync(outside, join(root, 'flowpact.sarif'));
    const r = await flowpact(['lint', '--root', root, '-o', join(root, 'flowpact.sarif')]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('is a symlink, or links outside');
    expect(readFileSync(outside, 'utf8')).toBe('keep');
  });
});

describe('base config', () => {
  it('puts the repository config on top of --base-config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowpact-base-'));
    const root = join(dir, 'repo');
    cpSync(fixture('incident-matrix'), root, { recursive: true });
    const base = join(dir, 'acme.base.yml');
    writeFileSync(base, 'rules:\n  FP401: warning\n  acme-rule: error\n');
    const severity = async (...args: string[]) => {
      const r = await flowpact(['lint', '--root', root, '--format', 'json', '-q', ...args]);
      return { exit: r.exitCode, severity: JSON.parse(r.stdout).findings[0].severity };
    };
    expect(await severity()).toEqual({ exit: 1, severity: 'error' });
    expect(await severity('--base-config', base)).toEqual({ exit: 0, severity: 'warning' });
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    writeFileSync(join(root, '.github/flowpact/flowpact.config.yml'), 'rules:\n  FP401: info\n');
    expect(await severity('--base-config', base)).toEqual({ exit: 0, severity: 'info' });

    const pretty = await flowpact(['lint', '--root', root, '--base-config', base]);
    expect(pretty.stderr).toContain(`config .github/flowpact/flowpact.config.yml · base ${base}`);
    // An organization rule that this run does not load is ignored, not an error.
    expect(pretty.stderr).toContain(
      'ignoring config entries for rules that are not loaded: rules.acme-rule: unknown rule "acme-rule"',
    );

    writeFileSync(base, 'plugins: [./acme.mjs]\n');
    const refused = await flowpact(['lint', '--root', root, '--base-config', base]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain('plugins: not in a base config; load organization rules with --plugin');
  });

  it('keeps a typo of a built-in rule an error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-typo-'));
    cpSync(fixture('clean'), root, { recursive: true });
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    writeFileSync(join(root, '.github/flowpact/flowpact.config.yml'), 'rules:\n  unused-inptu: off\n');
    const r = await flowpact(['lint', '--root', root]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('rules.unused-inptu: unknown rule (did you mean unused-input?)');
  });
});

describe('review fixes', () => {
  it('exits 2 for argument errors, unknown --only rules and missing paths', async () => {
    const root = fixture('broken');
    const notADir = join(mkdtempSync(join(tmpdir(), 'flowpact-notdir-')), 'file');
    writeFileSync(notADir, 'x');
    const cases = [
      ['lint', '--format', 'xml'],
      ['lint', '--fail-on', 'bogus'],
      ['frob'],
      ['explain'],
      ['lint', '--root', root, '--only', 'FP9999'],
      ['lint', '--root', root, '.github/workflow/schema.yml'],
      ['lint', '--root', root, 'README.md'],
      ['trace', 'x.yml', '--depth', '0', '--root', root],
      ['generate', '--root', mkdtempSync(join(tmpdir(), 'flowpact-empty-gen-'))],
      // Under a regular file: fails on every OS (a path in /proc can make Node's recursive mkdir loop on Linux).
      ['lint', '--root', fixture('clean'), '-o', join(notADir, 'sub', 'report.json')],
    ];
    // Independent processes: run them together so slow CI runners stay well within the timeout.
    const results = await Promise.all(cases.map((args) => flowpact(args)));
    expect(results.map((r, i) => ({ args: cases[i], code: r.exitCode }))).toEqual(
      cases.map((args) => ({ args, code: 2 })),
    );
    const typo = await flowpact(['lint', '--root', root, '--only', 'unused-inptu']);
    expect(typo.stderr).toContain('did you mean unused-input?');
  }, 120_000);

  it('only treats real workflows and actions under a directory argument as targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-dirs-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, '.github/ISSUE_TEMPLATE'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/a.yml'),
      'on: push\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    );
    writeFileSync(join(root, '.github/dependabot.yml'), 'version: 2\nupdates: []\n');
    writeFileSync(join(root, '.github/ISSUE_TEMPLATE/bug.yml'), 'name: Bug\nbody: []\n');
    const r = await flowpact(['lint', '--root', root, '.github']);
    expect(r.exitCode).toBe(0);
  });

  it('FORCE_COLOR=0 disables colors', async () => {
    const r = await flowpact(['lint', '--root', fixture('incident-matrix')], { FORCE_COLOR: '0' });
    expect(r.stdout).not.toMatch(/\u001B\[/);
  });

  it('neutralizes control characters taken from workflow YAML', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-ctl-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/c.yml'),
      'on: push\njobs:\n  call:\n    uses: ./.github/workflows/r.yml\n    with:\n      "x\\n::warning title=flowpact::All good\\e[2K": 1\n',
    );
    writeFileSync(
      join(root, '.github/workflows/r.yml'),
      'on:\n  workflow_call:\n    inputs:\n      a: {}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ inputs.a }}\n',
    );
    const r = await flowpact(['lint', '--root', root]);
    expect(r.stdout).not.toMatch(/^\s*::warning/m);
    expect(r.stdout).not.toContain('\u001B[2K');
    expect(r.stdout).toContain('\\x1b[2K');
  });

  it('trace explains a workflow without an interface', async () => {
    const r = await flowpact(['trace', 'ci.yml', '--root', fixture('clean')]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('declares no inputs, secrets or outputs');
  });
});

describe('review round 2 (CLI)', () => {
  it('FORCE_COLOR=0 also disables colors in error messages', async () => {
    const r = await flowpact(['lint', '--format', 'xml'], { FORCE_COLOR: '0' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).not.toMatch(/\u001B\[/);
  });

  it('`flowpact lint .` reports on the whole repository', async () => {
    const r = await flowpact(['lint', '.', '--root', fixture('incident-matrix')]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('FP401');
  });

  it('trace JSON has the same shape for one or many matches', async () => {
    const one = JSON.parse(
      (
        await flowpact([
          'trace',
          'tests.yml#inputs.suite',
          '--root',
          fixture('incident-matrix'),
          '-q',
          '--format',
          'json',
        ])
      ).stdout,
    );
    expect(Array.isArray(one.traces)).toBe(true);
    expect(one.traces).toHaveLength(1);
  });
});
