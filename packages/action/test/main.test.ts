import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, writeContracts } from '@flowpact/lint';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

interface Annotation {
  level: 'error' | 'warning' | 'notice';
  message: string;
  props?: Record<string, unknown>;
}

const state = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  outputs: {} as Record<string, string>,
  annotations: [] as Annotation[],
  infos: [] as string[],
  debugs: [] as string[],
  groups: [] as string[],
  /** The step log in order: lines, and the groups startGroup() and endGroup() open and close. */
  stepLog: [] as string[],
  summary: '',
  summaryWrites: 0,
  failed: [] as string[],
  isDebug: false,
  uploads: [] as { name: string; files: string[]; root: string; options: unknown; patch: string }[],
  uploadError: undefined as Error | undefined,
}));

vi.mock('@actions/core', () => {
  const annotation =
    (level: Annotation['level']) => (message: string | Error, props?: Record<string, unknown>) =>
      void state.annotations.push({ level, message: String(message), ...(props ? { props } : {}) });
  const summary = {
    addRaw(text: string) {
      state.summary += text;
      return summary;
    },
    async write() {
      state.summaryWrites++;
      return summary;
    },
  };
  return {
    getInput: (name: string) => state.inputs[name] ?? '',
    setOutput: (name: string, value: unknown) => {
      state.outputs[name] = String(value);
    },
    setFailed: (message: string | Error) => void state.failed.push(String(message)),
    isDebug: () => state.isDebug,
    debug: (m: string) => {
      state.debugs.push(m);
      state.stepLog.push(`::debug::${m}`);
    },
    info: (m: string) => {
      state.infos.push(m);
      state.stepLog.push(m);
    },
    error: annotation('error'),
    warning: annotation('warning'),
    notice: annotation('notice'),
    startGroup: (name: string) => {
      state.groups.push(name);
      state.stepLog.push(`::group::${name}`);
    },
    endGroup: () => void state.stepLog.push('::endgroup::'),
    group: async <T>(name: string, fn: () => Promise<T>) => {
      state.groups.push(name);
      return fn();
    },
    summary,
  };
});

vi.mock('../src/upload', () => ({
  async uploadArtifact(name: string, files: string[], root: string, options: unknown) {
    if (state.uploadError) throw state.uploadError;
    const patch = files.find((f) => f.endsWith('.patch'));
    state.uploads.push({ name, files, root, options, patch: patch ? readFileSync(patch, 'utf8') : '' });
    return { id: 42, size: 1234 };
  },
}));

const { ACTION_DIR, DEFAULTS, declaredDefaultsOf, run, summaryWithinLimit, SUMMARY_LIMIT } = await import(
  '../src/main'
);

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = join(REPO, 'fixtures');
const ENV_KEYS = [
  'GITHUB_WORKSPACE',
  'GITHUB_EVENT_NAME',
  'GITHUB_ACTION',
  'GITHUB_SERVER_URL',
  'GITHUB_REPOSITORY',
  'GITHUB_SHA',
  'GITHUB_RUN_ID',
  'GITHUB_ACTIONS',
  'RUNNER_TEMP',
  'RUNNER_DEBUG',
  'ACTIONS_STEP_DEBUG',
  'FLOWPACT_DEBUG',
];

let saved: Record<string, string | undefined>;
let temp: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  temp = mkdtempSync(join(tmpdir(), 'flowpact-action-'));
  process.env.RUNNER_TEMP = join(temp, 'runner-temp');
  Object.assign(state, {
    inputs: {},
    outputs: {},
    annotations: [],
    infos: [],
    debugs: [],
    groups: [],
    stepLog: [],
    summary: '',
    summaryWrites: 0,
    failed: [],
    isDebug: false,
    uploads: [],
    uploadError: undefined,
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(temp, { recursive: true, force: true });
});

async function action(workspace: string, inputs: Record<string, string> = {}) {
  process.env.GITHUB_WORKSPACE = workspace;
  state.inputs = inputs;
  await run();
  return state;
}

/** A copy of a fixture in a fresh git repository (optionally under a subdirectory). */
function repoFrom(fixture: string, sub = ''): { workspace: string; root: string } {
  const workspace = join(temp, 'repo');
  const root = join(workspace, sub);
  cpSync(join(FIXTURES, fixture), root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  return { workspace, root };
}

/** Writes the current contracts (what `flowpact generate` does) so later edits show up as drift. */
function lockContracts(root: string): void {
  const result = analyze({ root, checkContracts: true });
  writeContracts(root, result.contracts!);
}

function addRequiredInput(root: string): void {
  const file = join(root, '.github/workflows/build.yml');
  const text = readFileSync(file, 'utf8');
  writeFileSync(
    file,
    text.replace(
      '      verbose:\n',
      '      region:\n        type: string\n        required: true\n      verbose:\n',
    ),
  );
}

describe('lint mode', () => {
  it('fails on errors and annotates them where they are', async () => {
    const s = await action(join(FIXTURES, 'incident-matrix'));
    expect(s.infos[0]).toContain('config schema v1');
    expect(s.infos[0]).toMatch(/^flowpact v\d+\.\d+\.\d+/);
    expect(s.failed).toEqual(['flowpact found 1 error.']);
    const errors = s.annotations.filter((a) => a.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.props).toEqual({
      title: 'FP401 empty-binding-for-matrix-combo',
      file: '.github/workflows/tests.yml',
      startLine: 23,
      endLine: 23,
      startColumn: 19,
      endColumn: 32,
    });
    expect(errors[0]!.message).toContain('https://ciatlas.github.io/flowpact/docs/rules/fp401');
    expect(s.outputs).toMatchObject({
      errors: '1',
      warnings: '0',
      findings: '1',
      'exit-code': '1',
      drift: 'false',
      breaking: '0',
      patch: '',
      'artifact-id': '',
    });
    expect(s.groups).toContain('flowpact lint: analyze');
    // Progress lines go to the log, not to annotations.
    expect(s.infos.some((l) => l.startsWith('discovered 3 workflow(s)'))).toBe(true);
    expect(s.debugs).toEqual([]);
  });

  it('passes on a clean repository with zero outputs', async () => {
    const s = await action(join(FIXTURES, 'clean'));
    expect(s.failed).toEqual([]);
    expect(s.annotations).toEqual([]);
    expect(s.outputs).toMatchObject({
      errors: '0',
      warnings: '0',
      infos: '0',
      findings: '0',
      'exit-code': '0',
    });
    expect(s.summary).toContain('No problems found');
  });

  it('resolves working-directory and prefixes annotation paths and links with it', async () => {
    process.env.GITHUB_SERVER_URL = 'https://github.com';
    process.env.GITHUB_REPOSITORY = 'acme/repo';
    process.env.GITHUB_SHA = 'abc123';
    const s = await action(FIXTURES, { 'working-directory': 'incident-matrix' });
    expect(s.annotations.map((a) => a.props?.file)).toEqual(['incident-matrix/.github/workflows/tests.yml']);
    expect(s.summary).toContain(
      'https://github.com/acme/repo/blob/abc123/incident-matrix/.github/workflows/tests.yml#L23',
    );
  });

  it('does not fail with fail-on: never, but still annotates', async () => {
    const s = await action(join(FIXTURES, 'incident-matrix'), { 'fail-on': 'never' });
    expect(s.failed).toEqual([]);
    expect(s.outputs['exit-code']).toBe('0');
    expect(s.annotations).toHaveLength(1);
  });

  it('counts warnings with fail-on: warning', async () => {
    const s = await action(join(FIXTURES, 'deep-nesting'), { 'fail-on': 'warning' });
    expect(s.failed).toEqual(['flowpact found 4 errors and 7 warnings.']);
  });

  it('skips annotations and the summary when disabled', async () => {
    const s = await action(join(FIXTURES, 'incident-matrix'), { annotations: 'false', summary: 'false' });
    expect(s.annotations).toEqual([]);
    expect(s.summary).toBe('');
    expect(s.summaryWrites).toBe(0);
  });

  it('writes the job summary with docs links and an optional call graph', async () => {
    const s = await action(join(FIXTURES, 'incident-matrix'), { 'summary-graph': 'true' });
    expect(s.summaryWrites).toBe(1);
    expect(s.summary).toMatch(/^## flowpact lint\n/);
    expect(s.summary).toContain('[`FP401`](https://ciatlas.github.io/flowpact/docs/rules/fp401)');
    expect(s.summary).toContain('```mermaid');
  });

  it('writes report files relative to the workspace', async () => {
    const { workspace } = repoFrom('incident-matrix');
    const s = await action(workspace, {
      'report-json': 'reports/flowpact.json',
      'report-sarif': 'reports/flowpact.sarif',
      'report-markdown': join(temp, 'abs', 'flowpact.md'),
    });
    const json = JSON.parse(readFileSync(join(workspace, 'reports/flowpact.json'), 'utf8'));
    expect(json.summary.errors).toBe(1);
    const sarif = JSON.parse(readFileSync(join(workspace, 'reports/flowpact.sarif'), 'utf8'));
    expect(sarif.version).toBe('2.1.0');
    expect(readFileSync(join(temp, 'abs', 'flowpact.md'), 'utf8')).toContain('## flowpact lint');
    expect(s.outputs['report-json']).toBe(join(workspace, 'reports/flowpact.json'));
    expect(s.outputs['report-sarif']).toBe(join(workspace, 'reports/flowpact.sarif'));
  });

  it('makes SARIF locations relative to the workspace when working-directory is set', async () => {
    const { workspace } = repoFrom('incident-matrix', 'sub');
    await action(workspace, { 'working-directory': 'sub', 'report-sarif': 'flowpact.sarif' });
    const sarif = JSON.parse(readFileSync(join(workspace, 'flowpact.sarif'), 'utf8'));
    const uris = sarif.runs[0].results.flatMap(
      (r: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }) =>
        r.locations.map((l) => l.physicalLocation.artifactLocation.uri),
    );
    expect(uris).toEqual(['sub/.github/workflows/tests.yml']);
  });

  it('refuses to write a report through a symlink in the checkout', async () => {
    const { workspace } = repoFrom('incident-matrix');
    const outside = join(mkdtempSync(join(tmpdir(), 'flowpact-action-out-')), 'target.txt');
    writeFileSync(outside, 'keep');
    symlinkSync(outside, join(workspace, 'flowpact.sarif'));
    const s = await action(workspace, { 'report-sarif': 'flowpact.sarif' });
    expect(s.failed).toHaveLength(1);
    expect(s.failed[0]).toContain('is a symlink, goes through one in');
    expect(readFileSync(outside, 'utf8')).toBe('keep');
  });

  it('refuses to write a report through a directory link in the checkout, also one into .git', async () => {
    const { workspace } = repoFrom('incident-matrix');
    const gitConfig = readFileSync(join(workspace, '.git', 'config'), 'utf8');
    symlinkSync('.git', join(workspace, 'reports'));
    const s = await action(workspace, { 'report-sarif': 'reports/config' });
    expect(s.failed).toHaveLength(1);
    expect(s.failed[0]).toContain('is a symlink, goes through one in');
    expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe(gitConfig);
  });
});

describe('organization inputs', () => {
  /** A plugin rule that reports one finding, and records that its module ran. */
  const plugin = (code: string, marker: string) =>
    `globalThis[${JSON.stringify(marker)}] = true;
export default { code: '${code}', name: '${code.toLowerCase()}-rule', category: 'structure', defaultSeverity: 'error',
  docsUrl: 'https://example.com/${code}', docs: { summary: 'An organization rule.', why: 'Why.', fix: 'Fix.' },
  check(ctx) { ctx.report({ message: '${code} ran', loc: { file: '.github/workflows/tests.yml', line: 1, column: 1, endLine: 1, endColumn: 2 } }); } };\n`;
  const ran = (marker: string) => (globalThis as Record<string, unknown>)[marker] === true;

  it("reads relative paths from the action's own directory", () => {
    expect(existsSync(join(ACTION_DIR, 'action.yml'))).toBe(true);
    expect(join(ACTION_DIR, '/')).toBe(REPO);
  });

  it('reads the defaults a copy of the action declares, which an empty input falls back to', () => {
    const yml = join(temp, 'copy', 'action.yml');
    mkdirSync(dirname(yml), { recursive: true });
    writeFileSync(
      yml,
      'inputs:\n  base-config:\n    default: acme.base.yml\n  plugin:\n    default: |\n      rules/acme.mjs\n',
    );
    expect(declaredDefaultsOf(yml)).toEqual({ 'base-config': 'acme.base.yml', plugin: 'rules/acme.mjs\n' });
    expect(declaredDefaultsOf(join(temp, 'missing.yml'))).toEqual({});
    expect(state.annotations).toEqual([]);
    // flowpact's own action.yml declares the same defaults as the code.
    expect(declaredDefaultsOf(join(ACTION_DIR, 'action.yml'))).toMatchObject({
      'base-config': '',
      plugin: '',
    });
  });

  it('warns when the copy’s action.yml does not parse, instead of dropping its defaults silently', () => {
    const yml = join(temp, 'copy', 'action.yml');
    mkdirSync(dirname(yml), { recursive: true });
    // The defaults pasted as a second block of the same inputs.
    writeFileSync(yml, "inputs:\n  plugin:\n    default: ''\n  plugin:\n    default: rules/acme.mjs\n");
    expect(declaredDefaultsOf(yml)).toEqual({});
    expect(state.annotations).toHaveLength(1);
    expect(state.annotations[0]!.level).toBe('warning');
    const prefix = `Ignoring the input defaults of ${yml}, which cannot be read: `;
    expect(state.annotations[0]!.message.startsWith(prefix)).toBe(true);
    expect(state.annotations[0]!.message.length).toBeGreaterThan(prefix.length);
    expect(state.annotations[0]!.message).not.toMatch(/\n|:$/);
  });

  it('puts the repository config on top of base-config', async () => {
    const { workspace } = repoFrom('incident-matrix');
    const base = join(temp, 'org', 'acme.base.yml');
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(base, 'rules:\n  FP401: warning\n');
    const s = await action(workspace, { 'base-config': base });
    expect(s.failed).toEqual([]);
    expect(s.annotations.find((a) => a.message.includes('matrix combinations'))?.level).toBe('warning');
    expect(s.infos.some((m) => m.includes(`· base ${base}`))).toBe(true);
  });

  it('loads the plugin input whatever the plugins input says, but not files of the checkout on untrusted events', async () => {
    const { workspace } = repoFrom('incident-matrix');
    const org = join(temp, 'org', 'acme.mjs');
    mkdirSync(dirname(org), { recursive: true });
    writeFileSync(org, plugin('ACME601', '__flowpactOrgPluginRan'));
    writeFileSync(join(workspace, 'pr.mjs'), plugin('PR601', '__flowpactCheckoutPluginRan'));
    process.env.GITHUB_EVENT_NAME = 'pull_request_target';
    const s = await action(workspace, { plugins: 'auto', plugin: `${org}\n${join(workspace, 'pr.mjs')}\n` });
    expect(ran('__flowpactOrgPluginRan')).toBe(true);
    expect(ran('__flowpactCheckoutPluginRan')).toBe(false);
    expect(s.annotations.some((a) => a.props?.title === 'ACME601 acme601-rule')).toBe(true);
    expect(s.annotations.filter((a) => a.level === 'warning').map((a) => a.message)).toContain(
      "Not loading the plugin input's pr.mjs from the checkout: plugins run code from the checkout and are disabled on pull_request_target events; set the plugins input to true to allow them.",
    );
  });

  it('names the plugin input’s files it skips because the plugins input is false', async () => {
    const { workspace } = repoFrom('incident-matrix');
    mkdirSync(join(workspace, 'rules'));
    writeFileSync(join(workspace, 'rules', 'a.mjs'), plugin('PRA601', '__flowpactCheckoutPluginA'));
    writeFileSync(join(workspace, 'rules', 'b.mjs'), plugin('PRB601', '__flowpactCheckoutPluginB'));
    process.env.GITHUB_EVENT_NAME = 'pull_request';
    const files = [join(workspace, 'rules', 'a.mjs'), join(workspace, 'rules', 'b.mjs')];
    const s = await action(workspace, { plugins: 'false', plugin: files.join('\n') });
    expect(ran('__flowpactCheckoutPluginA') || ran('__flowpactCheckoutPluginB')).toBe(false);
    expect(s.annotations.filter((a) => a.level === 'warning').map((a) => a.message)).toContain(
      "Not loading the plugin input's rules/a.mjs, rules/b.mjs from the checkout: the plugins input is false.",
    );
  });
});

describe('check mode', () => {
  it('reports drift, uploads the regenerated contracts and a patch that applies with git', async () => {
    const { workspace, root } = repoFrom('deep-nesting');
    lockContracts(root);
    addRequiredInput(root);
    process.env.GITHUB_RUN_ID = '987';

    const s = await action(workspace, { mode: 'check' });
    expect(s.outputs.drift).toBe('true');
    expect(Number(s.outputs.breaking)).toBeGreaterThan(0);
    expect(s.outputs['artifact-id']).toBe('42');
    expect(s.failed).toHaveLength(1);
    expect(s.failed[0]).toContain('contracts drifted');
    expect(s.failed[0]).toContain('flowpact-contracts.patch');

    expect(s.uploads).toHaveLength(1);
    const upload = s.uploads[0]!;
    expect(upload.name).toBe('flowpact-contracts');
    expect(upload.options).toEqual({ retentionDays: 7 });
    const inArtifact = upload.files.map((f) => f.slice(upload.root.length + 1)).sort();
    expect(inArtifact).toContain('flowpact-contracts.patch');
    expect(inArtifact).toContain('flowpact-contracts/README.md');
    expect(inArtifact).toContain(
      'flowpact-contracts/.github/flowpact/contracts/workflows/build.contract.yaml',
    );
    for (const f of upload.files) expect(existsSync(f)).toBe(true);
    expect(s.outputs.patch).toBe(join(upload.root, 'flowpact-contracts.patch'));

    expect(s.summary).toContain('gh run download 987 -n flowpact-contracts');
    expect(s.summary).toContain('git apply --index flowpact-contracts.patch');
    expect(readFileSync(join(upload.root, 'flowpact-contracts/README.md'), 'utf8')).toContain(
      'git apply --index flowpact-contracts.patch',
    );

    execFileSync('git', ['apply', s.outputs.patch!], { cwd: workspace });
    const again = await action(workspace, { mode: 'check' });
    expect(again.outputs.drift).toBe('false');
    expect(again.uploads).toHaveLength(1);
  });

  it('writes repository-relative paths into the patch when working-directory is set', async () => {
    const { workspace, root } = repoFrom('deep-nesting', 'apps/ci');
    lockContracts(root);
    addRequiredInput(root);
    const s = await action(workspace, { mode: 'check', 'working-directory': 'apps/ci' });
    const patch = s.uploads[0]!.patch;
    expect(patch).toContain('diff --git a/apps/ci/.github/flowpact/contracts/workflows/build.contract.yaml');
    execFileSync('git', ['apply', '--check', s.outputs.patch!], { cwd: workspace });
  });

  it('keeps going when the upload fails and points at flowpact generate instead', async () => {
    const { workspace, root } = repoFrom('deep-nesting');
    lockContracts(root);
    addRequiredInput(root);
    state.uploadError = new Error('Unable to get the ACTIONS_RUNTIME_TOKEN env variable');
    const s = await action(workspace, { mode: 'check' });
    expect(
      s.annotations.some((a) => a.level === 'warning' && a.message.includes('ACTIONS_RUNTIME_TOKEN')),
    ).toBe(true);
    expect(s.outputs.drift).toBe('true');
    expect(s.outputs['artifact-id']).toBe('');
    expect(s.outputs.patch).not.toBe('');
    expect(s.summary).not.toContain('gh run download');
    expect(s.failed[0]).toContain('run flowpact generate');
  });

  it('does not upload when upload-contracts is false', async () => {
    const { workspace, root } = repoFrom('deep-nesting');
    lockContracts(root);
    addRequiredInput(root);
    const s = await action(workspace, { mode: 'check', 'upload-contracts': 'false', 'fail-on': 'never' });
    expect(s.uploads).toEqual([]);
    expect(s.outputs.drift).toBe('true');
    expect(s.failed).toEqual([]);
  });
});

describe('logging and errors', () => {
  it('prints debug logs when the debug input is set', async () => {
    const s = await action(join(FIXTURES, 'incident-matrix'), { debug: 'true' });
    expect(s.infos.some((l) => l.startsWith('debug: [flowpact] config resolved'))).toBe(true);
    expect(s.debugs).toEqual([]);
  });

  it('sends debug logs to core.debug when step debug logging is on', async () => {
    state.isDebug = true;
    const s = await action(join(FIXTURES, 'incident-matrix'));
    expect(s.debugs.some((l) => l.startsWith('[flowpact] config resolved'))).toBe(true);
    expect(s.debugs.some((l) => l.startsWith('[flowpact:rules] FP401'))).toBe(true);
  });

  it('fails with the config problem and its issues', async () => {
    const { workspace } = repoFrom('incident-matrix');
    writeFileSync(join(workspace, 'bad.yml'), 'rules:\n  unused-inptu: error\n');
    const s = await action(workspace, { config: 'bad.yml' });
    expect(s.failed).toHaveLength(1);
    expect(s.failed[0]).toMatch(/unknown rules/);
    expect(s.failed[0]).toContain('  - rules.unused-inptu: unknown rule (did you mean unused-input?)');
  });

  it('fails when the config file does not exist', async () => {
    const s = await action(join(FIXTURES, 'clean'), { config: 'missing.yml' });
    expect(s.failed[0]).toContain('Config file not found');
  });

  it('rejects invalid inputs', async () => {
    const s = await action(join(FIXTURES, 'clean'), { mode: 'generate' });
    expect(s.failed).toEqual(['Input mode must be one of lint, check (got "generate")']);
  });

  it('fails when there are no workflows', async () => {
    mkdirSync(join(temp, 'empty'));
    const s = await action(join(temp, 'empty'));
    expect(s.failed[0]).toContain('No workflows found');
  });
});

describe('action.yml', () => {
  const meta = parse(readFileSync(join(REPO, 'action.yml'), 'utf8')) as {
    name: string;
    description: string;
    branding: { icon: string; color: string };
    inputs: Record<string, { default: string; description: string }>;
    outputs: Record<string, { description: string }>;
    runs: { using: string; main: string };
  };

  it('declares the defaults the code uses', () => {
    expect(Object.fromEntries(Object.entries(meta.inputs).map(([k, v]) => [k, v.default]))).toEqual(DEFAULTS);
    for (const v of Object.values(meta.inputs)) expect(v.description).toBeTruthy();
  });

  it('declares every output the action sets', async () => {
    const s = await action(join(FIXTURES, 'clean'));
    expect(Object.keys(meta.outputs).sort()).toEqual(Object.keys(s.outputs).sort());
  });

  it('meets the GitHub Marketplace requirements', () => {
    // The Marketplace rejects a description of 125 characters or more and needs branding.
    expect(meta.description.length).toBeLessThan(125);
    expect(meta.name).toBeTruthy();
    expect(meta.branding.icon && meta.branding.color).toBeTruthy();
  });

  it('runs the committed bundle on node24', () => {
    expect(meta.runs).toEqual({ using: 'node24', main: 'packages/action/dist/index.js' });
  });

  it('has the same version as the engine', async () => {
    const { VERSION } = await import('@flowpact/lint');
    const pkg = JSON.parse(readFileSync(join(REPO, 'packages/action/package.json'), 'utf8'));
    expect(pkg.version).toBe(VERSION);
  });
});

describe('impact mode', () => {
  /** A git repository whose reusable workflow's job is renamed on a branch. */
  function renamedRepo(): string {
    const workspace = mkdtempSync(join(temp, 'impact-'));
    const wf = join(workspace, '.github/workflows/ci-reusable.yml');
    mkdirSync(join(workspace, '.github/workflows'), { recursive: true });
    const g = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    const body = (name: string) =>
      `on: workflow_call\njobs:\n  test:\n    name: ${name}\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n`;
    writeFileSync(wf, body('Test'));
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'change');
    writeFileSync(wf, body('Unit tests'));
    g('commit', '-q', '-am', 'change');
    return workspace;
  }

  it('fails an under-declared change and sets the impact outputs', async () => {
    const s = await action(renamedRepo(), { impact: 'on', 'base-ref': 'main', 'expected-impact': 'patch' });
    expect(s.outputs['required-impact']).toBe('major');
    expect(s.outputs['declared-impact']).toBe('patch');
    expect(s.outputs['impact-ok']).toBe('false');
    expect(s.failed).toHaveLength(1);
    expect(s.annotations.some((a) => String(a.props?.title ?? '').startsWith('FP810'))).toBe(true);
    expect(s.summary).toContain('### Impact');
  });

  it('passes a declared major and stays off by default', async () => {
    const ok = await action(renamedRepo(), { impact: 'on', 'base-ref': 'main', 'expected-impact': 'major' });
    expect(ok.outputs['impact-ok']).toBe('true');
    expect(ok.failed).toEqual([]);
    const off = await action(renamedRepo(), {});
    expect(off.outputs['impact-ok']).toBe('');
  });

  it('grades only the published workflows within paths, and a path the change removed', async () => {
    const workspace = renamedRepo();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    // Two more reusable workflows on main: one the branch keeps unchanged, one it deletes.
    g('checkout', '-q', 'main');
    const other =
      'on: workflow_call\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps: [{ run: "true" }]\n';
    writeFileSync(join(workspace, '.github/workflows/other.yml'), other);
    writeFileSync(join(workspace, '.github/workflows/gone.yml'), other);
    g('add', '-A');
    g('commit', '-q', '-m', 'more');
    g('checkout', '-q', 'change');
    g('merge', '-q', '--no-edit', 'main');
    g('rm', '-q', '.github/workflows/gone.yml');
    g('commit', '-q', '-m', 'gone');
    const inputs = (paths: string) => ({
      impact: 'on',
      'base-ref': 'main',
      'expected-impact': 'patch',
      paths,
    });
    /** A run of its own: what the runs before it reported is cleared. */
    const fresh = (given: Record<string, string>) => {
      Object.assign(state, { outputs: {}, annotations: [], summary: '', failed: [] });
      return action(workspace, given);
    };

    const unchanged = await fresh(inputs('.github/workflows/other.yml'));
    expect(unchanged.outputs['required-impact']).toBe('none');
    expect(unchanged.outputs['impact-ok']).toBe('true');
    expect(unchanged.failed).toEqual([]);
    expect(unchanged.summary).toContain(
      '<sub>Only within `.github/workflows/other.yml`: graded `.github/workflows/other.yml`</sub>',
    );

    const renamed = await fresh(inputs('.github/workflows/ci-reusable.yml'));
    expect(renamed.outputs['required-impact']).toBe('major');
    expect(renamed.outputs['impact-ok']).toBe('false');
    expect(renamed.failed).toHaveLength(1);

    const removed = await fresh(inputs('.github/workflows/gone.yml'));
    expect(removed.outputs['required-impact']).toBe('major');
    expect(removed.outputs['exit-code']).toBe('1');
    expect(removed.annotations.map((a) => String(a.props?.title ?? '').split(' ')[0])).toEqual(['FP810']);
    expect(removed.annotations[0]?.message).toContain('was removed or moved');

    const report = join(temp, 'impact.json');
    await fresh({ ...inputs('.github/workflows/other.yml'), 'report-json': report });
    expect(JSON.parse(readFileSync(report, 'utf8')).impact.scope).toEqual({
      paths: ['.github/workflows/other.yml'],
      units: ['.github/workflows/other.yml'],
    });
    // Without impact mode, the removed path is just missing.
    const lint = await fresh({ paths: '.github/workflows/gone.yml' });
    expect(lint.failed[0]).toContain('paths not found');
    expect(lint.outputs['exit-code']).toBe('2');
  });

  it('reports the verdict within paths that hold nothing published, and skips paths that hold nothing at all', async () => {
    const workspace = renamedRepo();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    // On main, two CI workflows that are not published; the branch deletes one of them.
    g('checkout', '-q', 'main');
    const ci = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps: [{ run: "true" }]\n';
    writeFileSync(join(workspace, '.github/workflows/ci.yml'), ci);
    writeFileSync(join(workspace, '.github/workflows/old-ci.yml'), ci);
    g('add', '-A');
    g('commit', '-q', '-m', 'ci');
    g('checkout', '-q', 'change');
    g('merge', '-q', '--no-edit', 'main');
    g('rm', '-q', '.github/workflows/old-ci.yml');
    g('commit', '-q', '-m', 'old ci gone');
    const fresh = (paths: string) => {
      Object.assign(state, { outputs: {}, annotations: [], infos: [], summary: '', failed: [] });
      return action(workspace, { impact: 'on', 'base-ref': 'main', 'expected-impact': 'major', paths });
    };

    // Before: FP812 annotated the root action.yml, which this repository does not have.
    const unpublished = await fresh('.github/workflows/ci.yml');
    expect(unpublished.outputs['required-impact']).toBe('none');
    expect(unpublished.annotations.map((a) => [String(a.props?.title).split(' ')[0], a.props?.file])).toEqual(
      [['FP812', '.github/workflows/ci.yml']],
    );

    const removed = await fresh('.github/workflows/old-ci.yml');
    expect(removed.failed).toEqual([]);
    expect(removed.outputs['exit-code']).toBe('0');
    expect(removed.outputs['required-impact']).toBe('');
    expect(removed.annotations).toEqual([]);
    expect(removed.infos).toContain('impact: skipped (nothing within the paths to grade or to report on)');
  });

  it('does not fail on a path the change removed when impact mode is skipped', async () => {
    const workspace = renamedRepo();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    g('checkout', '-q', 'main');
    writeFileSync(
      join(workspace, '.github/workflows/gone.yml'),
      'on: workflow_call\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps: [{ run: "true" }]\n',
    );
    g('add', '-A');
    g('commit', '-q', '-m', 'gone');
    g('checkout', '-q', 'change');
    g('merge', '-q', '--no-edit', 'main');
    g('rm', '-q', '.github/workflows/gone.yml');
    g('commit', '-q', '-m', 'remove gone');
    const fresh = (event: string, given: Record<string, string>) => {
      Object.assign(state, { outputs: {}, annotations: [], infos: [], summary: '', failed: [] });
      process.env.GITHUB_EVENT_NAME = event;
      return action(workspace, { paths: '.github/workflows/gone.yml', ...given });
    };

    // Before: "paths not found" failed the step in the merge queue and on push, after the pull request passed.
    for (const [event, given] of [
      ['merge_group', { impact: 'auto', 'base-ref': 'main' }],
      ['merge_group', { impact: 'on', 'base-ref': 'main' }],
      ['push', { impact: 'auto' }],
    ] as const) {
      const s = await fresh(event, given);
      expect(s.failed).toEqual([]);
      expect(s.outputs['exit-code']).toBe('0');
      expect(s.annotations.map((a) => [a.level, a.message])).toEqual([
        [
          'warning',
          'paths not found under .: .github/workflows/gone.yml. Not refused while impact mode is skipped, as the change may have removed them.',
        ],
      ]);
    }
    // Where no pull request's run with the baseline comes first, a failure as in 0.14. Before: a warning, exit-code 0.
    for (const [event, given] of [
      ['pull_request_target', { impact: 'auto' }],
      ['schedule', { impact: 'auto' }],
      ['workflow_dispatch', { impact: 'auto' }],
      ['workflow_dispatch', { impact: 'on', 'base-ref': 'change' }],
    ] as const) {
      const s = await fresh(event, given);
      expect(s.failed).toEqual(['paths not found under .: .github/workflows/gone.yml']);
      expect(s.outputs['exit-code']).toBe('2');
      expect(s.annotations).toEqual([]);
    }
    // Without impact mode, still a failure.
    expect((await fresh('push', {})).failed[0]).toContain('paths not found');
  });

  it('does not fail on a removed unit whose directory keeps other files when impact mode is skipped', async () => {
    const workspace = renamedRepo();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    g('checkout', '-q', 'main');
    mkdirSync(join(workspace, 'actions/old'), { recursive: true });
    writeFileSync(
      join(workspace, 'actions/old/action.yml'),
      'name: old\ndescription: d\nruns:\n  using: composite\n  steps: [{ shell: bash, run: "true" }]\n',
    );
    writeFileSync(join(workspace, 'actions/old/README.md'), '# old\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'old');
    g('checkout', '-q', 'change');
    g('merge', '-q', '--no-edit', 'main');
    g('rm', '-q', 'actions/old/action.yml');
    g('commit', '-q', '-m', 'remove old, keep its README');
    const fresh = (event: string, given: Record<string, string>) => {
      Object.assign(state, { outputs: {}, annotations: [], infos: [], summary: '', failed: [] });
      process.env.GITHUB_EVENT_NAME = event;
      return action(workspace, { paths: 'actions/old', ...given });
    };

    // Before: "None of the paths is a workflow … or an action" failed the step in the merge queue and on push.
    for (const [event, given] of [
      ['merge_group', { impact: 'auto', 'base-ref': 'main' }],
      ['merge_group', { impact: 'on', 'base-ref': 'main' }],
      ['push', { impact: 'auto' }],
    ] as const) {
      const s = await fresh(event, given);
      expect(s.failed).toEqual([]);
      expect(s.outputs['exit-code']).toBe('0');
      expect(s.annotations.map((a) => [a.level, a.message])).toEqual([
        [
          'warning',
          'paths without a workflow or action under .: actions/old. Not refused while impact mode is skipped, as the change may have removed them.',
        ],
      ]);
    }
    // Where no pull request's run with the baseline comes first, a failure as in 0.14. Before: a warning, exit-code 0.
    for (const event of ['pull_request_target', 'schedule']) {
      const s = await fresh(event, { impact: 'auto' });
      expect(s.failed[0]).toContain('None of the paths is a workflow');
      expect(s.outputs['exit-code']).toBe('2');
    }
    // Beside a path that names a workflow, actions/old was never refused, so there is nothing to warn about.
    const beside = await fresh('merge_group', {
      impact: 'auto',
      'base-ref': 'main',
      paths: 'actions/old .github/workflows/ci-reusable.yml',
    });
    expect(beside.failed).toEqual([]);
    expect(beside.annotations.filter((a) => a.level === 'warning')).toEqual([]);
    // Without impact mode, still a failure.
    expect((await fresh('push', {})).failed[0]).toContain('None of the paths is a workflow');
  });

  it('refuses a path that never existed on a pull request in a repository that publishes nothing', async () => {
    const workspace = mkdtempSync(join(temp, 'nopub-'));
    const g = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    const ci = (run: string) =>
      `on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps: [{ run: "${run}" }]\n`;
    mkdirSync(join(workspace, '.github/workflows'), { recursive: true });
    writeFileSync(join(workspace, '.github/workflows/ci.yml'), ci('true'));
    writeFileSync(join(workspace, '.github/workflows/old.yml'), ci('true'));
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'change');
    writeFileSync(join(workspace, '.github/workflows/ci.yml'), ci('false'));
    g('rm', '-q', '.github/workflows/old.yml');
    g('commit', '-q', '-am', 'change');
    const fresh = (paths: string) => {
      Object.assign(state, { outputs: {}, annotations: [], infos: [], summary: '', failed: [] });
      return action(workspace, { impact: 'auto', 'base-ref': 'main', paths });
    };

    // Before: a warning, exit-code 0 and nothing linted; impact: auto had dropped the baseline that tells them apart.
    const typo = await fresh('.github/workflows/typo.yml');
    expect(typo.failed).toEqual(['paths not found under .: .github/workflows/typo.yml']);
    expect(typo.outputs['exit-code']).toBe('2');
    // A path the change removed is still accepted, and nothing within the paths is published.
    const removed = await fresh('.github/workflows/old.yml');
    expect(removed.failed).toEqual([]);
    expect(removed.outputs['exit-code']).toBe('0');
    expect(removed.annotations).toEqual([]);
    expect(removed.infos).toContain(
      'impact: skipped (no published workflow or action within the paths; see impact.publish)',
    );
    // Without paths, as before.
    expect((await fresh('')).infos).toContain(
      'impact: no published workflows or actions (see impact.publish)',
    );
  });

  it("reads ignore from the baseline, so a pull request's own ignore edit does not change the impact outputs", async () => {
    const workspace = renamedRepo();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    // The branch that renames the reusable workflow's check also ignores the workflow.
    mkdirSync(join(workspace, '.github/flowpact'), { recursive: true });
    writeFileSync(
      join(workspace, '.github/flowpact/flowpact.config.yml'),
      'ignore: [".github/workflows/ci-reusable.yml"]\n',
    );
    g('add', '-A');
    g('commit', '-q', '-m', 'ignore it');
    const s = await action(workspace, { impact: 'on', 'base-ref': 'main', 'expected-impact': 'patch' });
    // Before: required-impact none and impact-ok true; 0.14 said major and false, but passed the step.
    expect(s.outputs['required-impact']).toBe('major');
    expect(s.outputs['impact-ok']).toBe('false');
    expect(s.outputs['exit-code']).toBe('1');
    expect(s.annotations.map((a) => String(a.props?.title).split(' ')[0])).toEqual(['FP810']);
    expect(s.infos).toContain(
      'impact: this pull request changes what ignore leaves out of impact mode (.github/workflows/ci-reusable.yml); that applies after it is merged',
    );
  });

  it('treats every published unit ignored like nothing published, and reports the verdict on a file ignore leaves in', async () => {
    const workspace = mkdtempSync(join(temp, 'ignored-'));
    const g = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    const actionYml = (input: string) =>
      `name: a\ndescription: d\ninputs:\n${input}runs:\n  using: composite\n  steps: [{ shell: bash, run: "true" }]\n`;
    const files: Record<string, string> = {
      '.github/flowpact/flowpact.config.yml':
        'ignore: ["*/action.yml"]\nimpact:\n  publish: ["*/action.yml"]\n',
      'a/action.yml': actionYml('  token: { description: t, required: false }\n'),
      'b/action.yml': actionYml('  token: { description: t, required: false }\n'),
      '.github/workflows/ci.yml':
        'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./a\n',
    };
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(workspace, f)), { recursive: true });
      writeFileSync(join(workspace, f), text);
    }
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'change');
    writeFileSync(join(workspace, 'b/action.yml'), actionYml(''));
    g('commit', '-q', '-am', 'break b');
    const fresh = (given: Record<string, string>) => {
      Object.assign(state, { outputs: {}, annotations: [], infos: [], summary: '', failed: [] });
      return action(workspace, { 'base-ref': 'main', 'expected-impact': 'major', ...given });
    };

    // Before: auto ran, graded nothing and annotated FP812 on action.yml, which this repository does not have.
    const auto = await fresh({ impact: 'auto' });
    expect(auto.infos).toContain(
      "impact: the baseline's and the pull request's ignore leave out every published workflow and action (a/action.yml, b/action.yml); see ignore",
    );
    expect(auto.annotations).toEqual([]);
    expect(auto.outputs['required-impact']).toBe('');
    // impact: on runs: nothing is graded, and the verdict goes on a workflow ignore leaves in.
    const on = await fresh({ impact: 'on' });
    expect(on.outputs['required-impact']).toBe('none');
    expect(on.annotations.map((a) => [String(a.props?.title).split(' ')[0], a.props?.file])).toEqual([
      ['FP812', '.github/workflows/ci.yml'],
    ]);
    // With paths, auto says it was ignore that left the unit out.
    const within = await fresh({ impact: 'auto', paths: 'b' });
    expect(within.infos).toContain(
      'impact: skipped (every published workflow or action within the paths is ignored; see ignore)',
    );
    expect(within.annotations).toEqual([]);
    // impact: on with those paths runs where a file within them is left in, and is skipped where none is.
    const beside = await fresh({ impact: 'on', paths: 'b .github/workflows/ci.yml' });
    expect(beside.outputs['required-impact']).toBe('none');
    expect(beside.annotations.map((a) => [String(a.props?.title).split(' ')[0], a.props?.file])).toEqual([
      ['FP812', '.github/workflows/ci.yml'],
    ]);
    const only = await fresh({ impact: 'on', paths: 'b' });
    expect(only.infos).toContain(
      'impact: skipped (every workflow and action within the paths is ignored: nothing to grade or to report on)',
    );
    expect(only.outputs['required-impact']).toBe('');
    expect(only.annotations).toEqual([]);
  });

  it('runs impact: auto on a pull request that takes the published units out of ignore, and fails it like 0.14', async () => {
    const workspace = mkdtempSync(join(temp, 'unignored-'));
    const g = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    const actionYml = (input: string) =>
      `name: a\ndescription: d\ninputs:\n${input}runs:\n  using: composite\n  steps: [{ shell: bash, run: "true" }]\n`;
    const config = '.github/flowpact/flowpact.config.yml';
    const files: Record<string, string> = {
      [config]: 'ignore: ["*/action.yml"]\nimpact:\n  publish: ["*/action.yml"]\n',
      'a/action.yml': actionYml('  token: { description: t, required: false }\n'),
      'b/action.yml': actionYml('  token: { description: t, required: false }\n'),
      '.github/workflows/ci.yml':
        'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./a\n',
    };
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(workspace, f)), { recursive: true });
      writeFileSync(join(workspace, f), text);
    }
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'change');
    writeFileSync(join(workspace, config), 'impact:\n  publish: ["*/action.yml"]\n');
    writeFileSync(join(workspace, 'b/action.yml'), actionYml(''));
    g('commit', '-q', '-am', 'take a and b out of ignore, break b');
    const s = await action(workspace, { impact: 'auto', 'base-ref': 'main', 'expected-impact': 'patch' });
    // Before: "every published workflow and action is ignored (see ignore)", and the step passed.
    expect(s.infos.filter((i) => i.includes('ignore'))).toEqual([]);
    expect(s.outputs['required-impact']).toBe('major');
    expect(s.outputs['impact-ok']).toBe('false');
    expect(s.outputs['exit-code']).toBe('1');
    const verdict = s.annotations.filter((a) => String(a.props?.title).startsWith('FP81'));
    expect(verdict.map((a) => [String(a.props?.title).split(' ')[0], a.props?.file])).toEqual([
      ['FP810', 'b/action.yml'],
    ]);
  });

  it("reads the baseline's version of a base-config file of the repository for the baseline's ignore", async () => {
    const workspace = mkdtempSync(join(temp, 'org-base-'));
    const g = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    const actionYml = (input: string) =>
      `name: a\ndescription: d\ninputs:\n${input}runs:\n  using: composite\n  steps: [{ shell: bash, run: "true" }]\n`;
    const files: Record<string, string> = {
      '.github/flowpact/flowpact.config.yml': 'impact:\n  publish: ["*/action.yml"]\n',
      '.github/org-base.yml': 'ignore: ["b/**"]\n',
      'a/action.yml': actionYml('  token: { description: t, required: false }\n'),
      'b/action.yml': actionYml('  token: { description: t, required: false }\n'),
    };
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(workspace, f)), { recursive: true });
      writeFileSync(join(workspace, f), text);
    }
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'change');
    writeFileSync(join(workspace, 'b/action.yml'), actionYml(''));
    g('commit', '-q', '-am', 'break b, which the base config ignores');
    const s = await action(workspace, {
      impact: 'on',
      'base-ref': 'main',
      'expected-impact': 'patch',
      'base-config': join(workspace, '.github/org-base.yml'),
    });
    // Before: "this pull request changes what ignore leaves out of impact mode (b)", and FP810 failed the step.
    expect(s.infos.filter((i) => i.includes('changes what ignore'))).toEqual([]);
    expect(s.outputs['required-impact']).toBe('none');
    expect(s.outputs['exit-code']).toBe('0');
    expect(s.failed).toEqual([]);
  });

  it('uses a base-config file of the workspace that the checked-out commit does not track on both sides', async () => {
    // The organization's config checked out into a gitignored directory of the workspace.
    const workspace = mkdtempSync(join(temp, 'org-checkout-'));
    const g = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    const actionYml = (input: string) =>
      `name: a\ndescription: d\ninputs:\n${input}runs:\n  using: composite\n  steps: [{ shell: bash, run: "true" }]\n`;
    const files: Record<string, string> = {
      '.github/flowpact/flowpact.config.yml': 'impact:\n  publish: ["*/action.yml"]\n',
      '.gitignore': '.org/\n',
      'a/action.yml': actionYml('  token: { description: t, required: false }\n'),
      'b/action.yml': actionYml('  token: { description: t, required: false }\n'),
    };
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(workspace, f)), { recursive: true });
      writeFileSync(join(workspace, f), text);
    }
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'change');
    writeFileSync(join(workspace, 'b/action.yml'), actionYml(''));
    g('commit', '-q', '-am', 'break b, which the base config ignores');
    mkdirSync(join(workspace, '.org'));
    writeFileSync(join(workspace, '.org/base.yml'), 'ignore: ["b/**"]\n');
    const s = await action(workspace, {
      impact: 'on',
      'base-ref': 'main',
      'expected-impact': 'patch',
      'base-config': join(workspace, '.org/base.yml'),
    });
    // Before: "this pull request changes what ignore leaves out of impact mode (b)", and FP810 failed the step.
    expect(
      s.infos.filter((i) => i.includes('ignore leaves out') || i.includes('file of this repository')),
    ).toEqual([]);
    expect(s.outputs['required-impact']).toBe('none');
    expect(s.outputs['exit-code']).toBe('0');
    expect(s.failed).toEqual([]);
  });

  it("runs impact: auto where the commit a pull request records for a base config's submodule ignores less", async () => {
    const workspace = mkdtempSync(join(temp, 'org-submodule-'));
    const org = join(workspace, '.org');
    const init = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      for (const args of [
        ['init', '-q', '-b', 'main'],
        ['config', 'user.email', 't@example.com'],
        ['config', 'user.name', 't'],
        ['config', 'commit.gpgsign', 'false'],
      ])
        execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    };
    const g = (dir: string, ...args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
    const actionYml = (input: string) =>
      `name: a\ndescription: d\ninputs:\n${input}runs:\n  using: composite\n  steps: [{ shell: bash, run: "true" }]\n`;
    init(workspace);
    init(org);
    // The organization's config ignores every published action at v1, and nothing at v2.
    const versions = ['ignore: ["*/action.yml"]\n', 'ignore: []\n'].map((text, i) => {
      writeFileSync(join(org, 'base.yml'), text);
      g(org, 'add', '-A');
      g(org, 'commit', '-q', '-m', `v${i + 1}`);
      return g(org, 'rev-parse', 'HEAD');
    });
    g(org, 'checkout', '-q', versions[0]!);
    const files: Record<string, string> = {
      '.github/flowpact/flowpact.config.yml': 'impact:\n  publish: ["*/action.yml"]\n',
      'a/action.yml': actionYml('  token: { description: t, required: false }\n'),
      'b/action.yml': actionYml('  token: { description: t, required: false }\n'),
    };
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(workspace, f)), { recursive: true });
      writeFileSync(join(workspace, f), text);
    }
    g(workspace, 'add', '-A');
    g(workspace, 'commit', '-q', '-m', 'base');
    // The pull request records v2 and breaks b; the submodule is checked out at v1 (`git submodule update --remote`
    // checks out another commit than the one recorded).
    g(workspace, 'checkout', '-q', '-b', 'change');
    g(org, 'checkout', '-q', versions[1]!);
    writeFileSync(join(workspace, 'b/action.yml'), actionYml(''));
    g(workspace, 'add', '-A');
    g(workspace, 'commit', '-q', '-m', 'record v2, break b');
    g(org, 'checkout', '-q', versions[0]!);
    const s = await action(workspace, {
      impact: 'auto',
      'base-ref': 'main',
      'expected-impact': 'patch',
      'base-config': join(org, 'base.yml'),
    });
    // Before: "impact: the baseline's and the pull request's ignore leave out every published workflow and action
    // (a/action.yml, b/action.yml); see ignore", and exit-code 0, where impact: on failed with FP810.
    expect(s.infos.filter((i) => i.includes('leave out every published'))).toEqual([]);
    expect(s.outputs['required-impact']).toBe('major');
    expect(s.outputs['impact-ok']).toBe('false');
    expect(s.outputs['exit-code']).toBe('1');
  });

  it('skips impact: auto when nothing within the paths is published', async () => {
    const workspace = renamedRepo();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    g('checkout', '-q', 'main');
    writeFileSync(
      join(workspace, '.github/workflows/ci.yml'),
      'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps: [{ run: "true" }]\n',
    );
    g('add', '-A');
    g('commit', '-q', '-m', 'ci');
    g('checkout', '-q', 'change');
    g('merge', '-q', '--no-edit', 'main');
    const fresh = (given: Record<string, string>) => {
      Object.assign(state, { outputs: {}, annotations: [], infos: [], summary: '', failed: [] });
      return action(workspace, { impact: 'auto', 'base-ref': 'main', ...given });
    };

    // Before: the repository publishes ci-reusable.yml, so auto ran and annotated an FP813 about nothing.
    const ci = await fresh({ paths: '.github/workflows/ci.yml' });
    expect(ci.infos).toContain(
      'impact: skipped (no published workflow or action within the paths; see impact.publish)',
    );
    expect(ci.annotations).toEqual([]);
    expect(ci.outputs['required-impact']).toBe('');
    expect(ci.summary).not.toContain('### Impact');
    // A published unit within the paths, or no paths: it runs.
    expect((await fresh({ paths: '.github/workflows' })).outputs['required-impact']).toBe('major');
    expect((await fresh({})).outputs['required-impact']).toBe('major');
    // impact: on still reports the verdict within the paths.
    expect(
      (await fresh({ impact: 'on', paths: '.github/workflows/ci.yml' })).outputs['required-impact'],
    ).toBe('none');
  });

  it('opens the impact baseline group only when something is logged in it', async () => {
    const off = await action(renamedRepo(), { impact: 'off' });
    expect(off.groups).not.toContain('flowpact: impact baseline');
    const skipped = await action(renamedRepo(), { impact: 'auto' });
    expect(skipped.groups).not.toContain('flowpact: impact baseline');
    expect(skipped.infos).toContain('impact: auto runs on pull requests');
    const logged = await action(renamedRepo(), {
      impact: 'on',
      'base-ref': 'main',
      'expected-impact': 'major',
      debug: 'true',
    });
    expect(logged.groups.filter((g) => g === 'flowpact: impact baseline')).toHaveLength(1);
    // The group opens before the first line logged in it, holds the lines, and closes; groups pair up in every run.
    const start = logged.stepLog.indexOf('::group::flowpact: impact baseline');
    const end = logged.stepLog.indexOf('::endgroup::', start);
    expect(logged.stepLog.slice(start + 1, end).some((l) => l.includes('impact baseline {'))).toBe(true);
    expect(logged.stepLog.slice(0, start).some((l) => l.includes('impact baseline {'))).toBe(false);
    const opens = logged.stepLog.filter((l) => l.startsWith('::group::')).length;
    expect(logged.stepLog.filter((l) => l === '::endgroup::')).toHaveLength(opens);
  });
});

describe('review fixes', () => {
  it('fails (exit 2) on paths that do not exist, instead of reporting nothing', async () => {
    const s = await action(join(FIXTURES, 'broken'), { paths: '.github/workflow/schema.yml' });
    expect(s.failed[0]).toContain('paths not found');
    expect(s.outputs['exit-code']).toBe('2');
  });

  it('sets every output even when it stops early', async () => {
    const empty = join(temp, 'empty');
    mkdirSync(empty);
    const s = await action(empty);
    expect(s.failed).toHaveLength(1);
    expect(s.outputs).toMatchObject({
      errors: '0',
      breaking: '0',
      drift: 'false',
      'exit-code': '2',
      patch: '',
    });
  });

  it('does not run plugins on untrusted events unless allowed', async () => {
    const { workspace, root } = repoFrom('clean');
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    writeFileSync(join(root, '.github/flowpact/flowpact.config.yml'), 'plugins: [./evil.mjs]\n');
    writeFileSync(join(root, 'evil.mjs'), 'globalThis.__flowpactPluginRan = true;\nexport default [];\n');
    process.env.GITHUB_EVENT_NAME = 'pull_request_target';
    const s = await action(workspace);
    expect((globalThis as { __flowpactPluginRan?: boolean }).__flowpactPluginRan).toBeUndefined();
    expect(s.annotations.some((a) => a.level === 'warning' && a.message.includes('plugins'))).toBe(true);
    expect(s.failed).toEqual([]);
  });

  it('warns about config entries for skipped plugin rules and names the input that disabled them', async () => {
    const { workspace, root } = repoFrom('clean');
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    writeFileSync(
      join(root, '.github/flowpact/flowpact.config.yml'),
      'plugins: [./p.mjs]\nrules:\n  acme-no-echo: error\n',
    );
    process.env.GITHUB_EVENT_NAME = 'pull_request';
    const s = await action(workspace, { plugins: 'false' });
    const warnings = s.annotations.filter((a) => a.level === 'warning').map((a) => a.message);
    expect(warnings.some((m) => m.includes('the plugins input is false'))).toBe(true);
    expect(warnings.some((m) => m.includes('rules.acme-no-echo'))).toBe(true);
    expect(s.failed).toEqual([]);
  });

  it('keeps each step’s drift artifact separate and names it after working-directory', async () => {
    const { workspace, root } = repoFrom('deep-nesting', 'svc');
    lockContracts(root);
    addRequiredInput(root);
    process.env.GITHUB_ACTION = 'flowpact-svc';
    const s = await action(workspace, { mode: 'check', 'working-directory': 'svc' });
    expect(s.uploads[0]!.name).toBe('flowpact-contracts-svc');
    expect(s.uploads[0]!.root).toContain('flowpact-contracts-artifact-flowpact-svc-svc');
  });

  it('writes the drift artifact to a fresh private folder outside the runner', async () => {
    const { workspace, root } = repoFrom('deep-nesting', 'svc');
    lockContracts(root);
    addRequiredInput(root);
    delete process.env.RUNNER_TEMP;
    const a = (await action(workspace, { mode: 'check', 'working-directory': 'svc' })).uploads.at(-1)!.root;
    const b = (await action(workspace, { mode: 'check', 'working-directory': 'svc' })).uploads.at(-1)!.root;
    expect(a.startsWith(join(tmpdir(), 'flowpact-contracts-artifact-'))).toBe(true);
    expect(a).not.toBe(b);
    if (process.platform !== 'win32') expect(statSync(a).mode & 0o777).toBe(0o700);
  });

  it('shortens the job summary to stay within GitHub’s limit', async () => {
    const { memoryFileSystem } = await import('@ciatlas/core');
    const { analyze: run2 } = await import('@flowpact/lint');
    const files: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      const inputs = Array.from({ length: 30 }, (_, j) => `      i${j}: { type: string }`).join('\n');
      files[`.github/workflows/w${i}.yml`] =
        `on:\n  workflow_call:\n    inputs:\n${inputs}\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n`;
    }
    const result = run2({
      root: '/v',
      fs: memoryFileSystem(files),
      validateSchema: false,
      repository: 'a/b',
      config: (await import('@flowpact/lint')).parseConfig({
        overrides: [{ rule: 'unused-input', target: '**', reason: 'accepted while migrating (JIRA-1)' }],
      }),
    });
    expect(result.suppressed.length).toBe(6000);
    const md = summaryWithinLimit(result, { maxFindings: 50 });
    expect(Buffer.byteLength(md)).toBeLessThan(SUMMARY_LIMIT);
    expect(md).toContain('more suppressed findings');
  });
});

describe('remotes: fetch', () => {
  const SHA = 'b'.repeat(40);
  const hits: string[] = [];
  let server: import('node:http').Server;
  let api = '';

  beforeAll(async () => {
    const { createServer } = await import('node:http');
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      const body =
        req.url === '/repos/octo/setup/commits/v2'
          ? SHA
          : req.url === `/repos/octo/setup/contents/action.yml?ref=${SHA}`
            ? 'name: s\ndescription: d\ninputs:\n  version: { description: v, required: true }\nruns:\n  using: composite\n  steps: []\n'
            : undefined;
      res.writeHead(body === undefined ? 404 : 200).end(body ?? '');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    api = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  function workspace(): string {
    const root = join(temp, 'remotes');
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/ci.yml'),
      'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/setup@v2\n',
    );
    return root;
  }
  const fp101 = () => state.annotations.filter((a) => a.message.includes('without required input "version"'));

  it('fetches the interfaces the lockfile lacks with the token, for this run', async () => {
    process.env.GITHUB_API_URL = api;
    try {
      hits.length = 0;
      await action(workspace(), { remotes: 'fetch', token: 'tkn' });
      expect(fp101()).toHaveLength(1);
      expect(hits).toContain('/repos/octo/setup/commits/v2');
    } finally {
      delete process.env.GITHUB_API_URL;
    }
  });

  it('does not fetch by default, nor on pull_request_target', async () => {
    process.env.GITHUB_API_URL = api;
    try {
      hits.length = 0;
      await action(workspace(), { token: 'tkn' });
      expect(fp101()).toEqual([]);
      process.env.GITHUB_EVENT_NAME = 'pull_request_target';
      await action(workspace(), { remotes: 'fetch', token: 'tkn' });
      expect(fp101()).toEqual([]);
      expect(state.annotations.map((a) => a.message)).toContain(
        'remotes: fetch does not run on pull_request_target; only the committed remote interfaces lockfile is used.',
      );
      expect(hits).toEqual([]);
    } finally {
      delete process.env.GITHUB_API_URL;
    }
  });
});

describe('remotes-github-com on GitHub Enterprise Server', () => {
  const SHA = 'c'.repeat(40);
  const ACTION =
    'name: s\ndescription: d\ninputs:\n  version: { description: v, required: true }\nruns:\n  using: composite\n  steps: []\n';

  it('looks on github.com for what the enterprise server lacks, with github-com-token, never token', async () => {
    const seen: { host: string; auth: string | null }[] = [];
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ host: url.host, auth: new Headers(init?.headers).get('authorization') });
      if (url.host !== 'api.github.com') return new Response('', { status: 404 });
      if (url.pathname === '/repos/octo/setup/commits/v2') return new Response(SHA);
      if (url.pathname === '/repos/octo/setup/contents/action.yml') return new Response(ACTION);
      return new Response('', { status: 404 });
    });
    process.env.GITHUB_API_URL = 'https://ghes.example/api/v3';
    try {
      const root = join(temp, 'ghes');
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      writeFileSync(
        join(root, '.github/workflows/ci.yml'),
        'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/setup@v2\n',
      );
      await action(root, {
        remotes: 'fetch',
        'remotes-github-com': 'true',
        'github-com-token': 'dotcom',
        token: 'ghes',
      });
      expect(state.annotations.some((a) => a.message.includes('without required input "version"'))).toBe(
        true,
      );
      expect(seen.filter((r) => r.host === 'api.github.com').every((r) => r.auth === 'Bearer dotcom')).toBe(
        true,
      );
      expect(seen.filter((r) => r.host === 'ghes.example').every((r) => r.auth === 'Bearer ghes')).toBe(true);
      // Without remotes-github-com, github.com is never asked.
      seen.length = 0;
      await action(root, { remotes: 'fetch', token: 'ghes' });
      expect(seen.some((r) => r.host === 'api.github.com')).toBe(false);
    } finally {
      delete process.env.GITHUB_API_URL;
      vi.unstubAllGlobals();
    }
  });
});
