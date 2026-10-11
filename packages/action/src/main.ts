import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@actions/core';
import {
  createLogger,
  type Logger,
  type LogLevel,
  type LogRecord,
  type LogSink,
  loadProject,
  neutralizeWorkflowCommands,
  resolveCommit,
  resolveLogLevel,
} from '@flowpact/core';
import {
  type AnalysisResult,
  type AnalyzeOptions,
  analyze,
  assertSafeWritePath,
  bannerText,
  ConfigError,
  type ContractPlan,
  contractPatch,
  createRegistry,
  exitCodeFor,
  type Finding,
  type FlowpactConfig,
  githubEvent,
  type ImpactLevel,
  ImpactSetupError,
  isPublished,
  type LoadedConfig,
  loadConfig,
  loadPlugins,
  pathInside,
  prepareImpact,
  UnsafePathError,
  writeContracts,
} from '@flowpact/lint';
import {
  githubAnnotation,
  inRepository,
  type MarkdownOptions,
  renderJson,
  renderMarkdown,
  renderSarif,
} from '@flowpact/reporters';
import { parse as parseYaml } from 'yaml';
import { uploadArtifact } from './upload';

/** Input defaults; `action.yml` declares the same values (a test keeps them in sync). */
export const DEFAULTS = {
  mode: 'lint',
  paths: '',
  'working-directory': '.',
  config: '',
  'fail-on': 'error',
  annotations: 'true',
  summary: 'true',
  'summary-graph': 'false',
  'max-findings': '50',
  'report-json': '',
  'report-sarif': '',
  'report-markdown': '',
  'upload-contracts': 'true',
  'artifact-name': 'flowpact-contracts',
  'retention-days': '7',
  plugins: 'auto',
  'base-config': '',
  plugin: '',
  impact: 'off',
  'expected-impact': '',
  'base-ref': '',
  token: '${{ github.token }}',
  debug: 'false',
} as const;

/**
 * The action's own directory (where action.yml is): the bundle is packages/action/dist/index.js below it. Relative
 * `base-config` and `plugin` paths are read from here, so a copy of the action can ship its organization's files.
 */
export const ACTION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Events where the checkout may contain untrusted code while secrets or a write token are available. */
const UNTRUSTED_EVENTS = new Set(['pull_request_target', 'workflow_run']);

/** Largest job summary GitHub accepts per step is 1 MiB; stay below it. */
export const SUMMARY_LIMIT = 1_000_000;

type InputName = keyof typeof DEFAULTS;
type FailOn = 'error' | 'warning' | 'never';

/** Name of the patch inside the drift artifact; applied with `git apply` from the repository root. */
export const PATCH_FILE = 'flowpact-contracts.patch';
/**
 * Regenerated contract files and the README go under this folder of the artifact, so downloading the artifact
 * into the repository root (as the job summary suggests) never overwrites tracked files.
 */
export const ARTIFACT_DIR = 'flowpact-contracts';

class InputError extends Error {}

interface Inputs {
  mode: 'lint' | 'check';
  paths: string[];
  workingDirectory: string;
  config: string;
  failOn: FailOn;
  annotations: boolean;
  summary: boolean;
  summaryGraph: boolean;
  maxFindings: number;
  reportJson: string;
  reportSarif: string;
  reportMarkdown: string;
  uploadContracts: boolean;
  artifactName: string;
  retentionDays: number;
  /** Whether `plugins:` from the checked-out config may run. */
  plugins: boolean;
  /** `base-config`: an absolute path, or ''. */
  baseConfig: string;
  /** `plugin`: absolute paths of plugins loaded in addition to the config's. */
  extraPlugins: string[];
  impact: 'off' | 'auto' | 'on';
  expectedImpact?: ImpactLevel;
  baseRef: string;
  debug: boolean;
}

function input(name: InputName): string {
  return core.getInput(name).trim() || DEFAULTS[name];
}

function oneOf<T extends string>(name: InputName, options: readonly T[]): T {
  const value = input(name);
  if (!(options as readonly string[]).includes(value))
    throw new InputError(`Input ${name} must be one of ${options.join(', ')} (got "${value}")`);
  return value as T;
}

function bool(name: InputName): boolean {
  const value = input(name).toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(value)) return true;
  if (['false', 'no', 'off', '0'].includes(value)) return false;
  throw new InputError(`Input ${name} must be true or false (got "${value}")`);
}

function int(name: InputName): number {
  const value = input(name);
  if (!/^\d+$/.test(value))
    throw new InputError(`Input ${name} must be a non-negative integer (got "${value}")`);
  return Number(value);
}

/** A path from an input, relative to the action's own directory. */
const fromActionDir = (p: string) => (isAbsolute(p) ? p : resolve(ACTION_DIR, p));

/** The input defaults an action.yml declares; empty when it cannot be read, with a warning unless it does not exist. */
export function declaredDefaultsOf(actionYml: string): Record<string, string> {
  const defaults: Record<string, string> = {};
  try {
    const meta = parseYaml(readFileSync(actionYml, 'utf8')) as {
      inputs?: Record<string, { default?: unknown }>;
    };
    for (const [k, v] of Object.entries(meta?.inputs ?? {}))
      if (typeof v?.default === 'string') defaults[k] = v.default;
  } catch (err) {
    // No action.yml next to the bundle: flowpact's own defaults apply. One that does not parse (a copy's edit gone
    // wrong) must not drop the copy's defaults without a word.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // The first line of a YAML error, without the colon that introduces the excerpt below it.
      const reason = (err as Error).message.split('\n')[0]!.replace(/:$/, '');
      core.warning(`Ignoring the input defaults of ${actionYml}, which cannot be read: ${reason}`);
    }
  }
  return defaults;
}

let declaredDefaults: Record<string, string> | undefined;
/**
 * The default this copy of the action declares for an input in its own action.yml. The runner applies an action.yml
 * default only when a workflow leaves the input out, not when it passes an empty value (as a reusable workflow
 * forwarding an unset input does), so an organization's defaults would otherwise fall back to flowpact's.
 */
function declaredDefault(name: InputName): string {
  declaredDefaults ??= declaredDefaultsOf(join(ACTION_DIR, 'action.yml'));
  return declaredDefaults[name]?.trim() || DEFAULTS[name];
}

/** An input that an organization's copy of the action may set by default; empty means that default. */
const orgInput = (name: 'base-config' | 'plugin') => core.getInput(name).trim() || declaredDefault(name);

function readInputs(): Inputs {
  return {
    mode: oneOf('mode', ['lint', 'check']),
    paths: input('paths').split(/\s+/).filter(Boolean),
    workingDirectory: input('working-directory'),
    config: input('config'),
    failOn: oneOf('fail-on', ['error', 'warning', 'never']),
    annotations: bool('annotations'),
    summary: bool('summary'),
    summaryGraph: bool('summary-graph'),
    maxFindings: int('max-findings'),
    reportJson: input('report-json'),
    reportSarif: input('report-sarif'),
    reportMarkdown: input('report-markdown'),
    uploadContracts: bool('upload-contracts'),
    artifactName: input('artifact-name'),
    retentionDays: int('retention-days'),
    plugins: pluginsAllowed(oneOf('plugins', ['auto', 'true', 'false'])),
    baseConfig: orgInput('base-config') ? fromActionDir(orgInput('base-config')) : '',
    extraPlugins: orgInput('plugin')
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map(fromActionDir),
    impact: oneOf('impact', ['off', 'auto', 'on']),
    ...(input('expected-impact')
      ? { expectedImpact: oneOf('expected-impact', ['none', 'patch', 'minor', 'major']) as ImpactLevel }
      : {}),
    baseRef: input('base-ref'),
    debug: bool('debug'),
  };
}

/**
 * Makes `refs` available in a shallow checkout: fetched at depth 1 with a one-off authorization header passed through
 * the environment (never in argv, never written to .git/config). An empty value first clears the header
 * actions/checkout persists, since GitHub rejects a request with two Authorization headers.
 */
function fetchRefs(root: string, refs: string[], token: string, logger: Logger): void {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (token && !token.startsWith('${{')) {
    const host = new URL(process.env.GITHUB_SERVER_URL || 'https://github.com').host;
    const key = `http.https://${host}/.extraheader`;
    const n = Number(env.GIT_CONFIG_COUNT) || 0;
    Object.assign(env, {
      [`GIT_CONFIG_KEY_${n}`]: key,
      [`GIT_CONFIG_VALUE_${n}`]: '',
      [`GIT_CONFIG_KEY_${n + 1}`]: key,
      [`GIT_CONFIG_VALUE_${n + 1}`]: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      GIT_CONFIG_COUNT: String(n + 2),
    });
  }
  for (const ref of refs) {
    // A commit is fetched as is; `origin/<branch>` into its remote-tracking ref; refspecs (tags) unchanged.
    const spec = /^[0-9a-f]{7,64}$/i.test(ref)
      ? ref
      : ref.startsWith('origin/')
        ? `+refs/heads/${ref.slice('origin/'.length)}:refs/remotes/${ref}`
        : ref;
    try {
      execFileSync('git', ['-C', root, 'fetch', '--no-tags', '--depth=1', 'origin', spec], {
        env,
        stdio: 'pipe',
      });
      logger.debug(`fetched ${spec}`);
    } catch (err) {
      const stderr = String((err as { stderr?: Buffer }).stderr ?? '')
        .replace(/AUTHORIZATION: [^\s]+ [^\s]+/gi, 'AUTHORIZATION: ***')
        .trim()
        .split('\n')
        .slice(-2)
        .join(' ');
      logger.warn(`could not fetch ${spec}${stderr ? `: ${stderr}` : ''}`);
    }
  }
}

/** Impact mode's options for analyze(), or why it does not run. */
function impactSetup(
  root: string,
  config: FlowpactConfig,
  configPath: string | undefined,
  baseConfig: { file: string; data: Record<string, unknown> } | undefined,
  inputs: Inputs,
  logger: Logger,
): { options?: NonNullable<AnalyzeOptions['impact']>; note?: string } {
  if (inputs.impact === 'off') return {};
  const event = githubEvent();
  const auto = inputs.impact === 'auto';
  if (auto && event?.name === 'pull_request_target')
    return { note: 'impact: auto skips pull_request_target' };
  if (auto && event?.name !== 'pull_request' && !inputs.baseRef)
    return { note: 'impact: auto runs on pull requests' };
  // A branch name prefers its remote-tracking ref (a local branch can be stale on a reused workspace), then the ref as
  // given; when the clone has neither, the remote-tracking ref is fetched.
  const resolves = (ref: string) => {
    try {
      resolveCommit(root, ref);
      return true;
    } catch {
      return false;
    }
  };
  let base = inputs.baseRef;
  if (base && !/^[0-9a-f]{7,64}$/i.test(base) && !base.startsWith('refs/')) {
    const tracking = `origin/${base.replace(/^origin\//, '')}`;
    if (resolves(tracking) || !resolves(base)) base = tracking;
  }
  let prepared: ReturnType<typeof prepareImpact>;
  try {
    prepared = prepareImpact(
      root,
      config,
      {
        ...(base ? { base } : {}),
        ...(inputs.expectedImpact ? { expect: inputs.expectedImpact } : {}),
        ...(event ? { event } : {}),
        ...(process.env.GITHUB_REPOSITORY ? { repository: process.env.GITHUB_REPOSITORY } : {}),
        ...(configPath ? { configPath } : {}),
        ...(baseConfig ? { baseConfig: baseConfig.data, baseConfigFile: baseConfig.file } : {}),
        fetch: (refs) => fetchRefs(root, refs, core.getInput('token'), logger),
      },
      logger,
    );
  } catch (err) {
    if (err instanceof ImpactSetupError) throw new InputError(`impact: ${err.message}`);
    throw err;
  }
  if ('skip' in prepared) return { note: `impact: skipped (${prepared.skip})` };
  for (const n of prepared.notes) logger.info(`impact: ${n}`);
  if (auto && prepared.options.publishedFiles?.length === 0) {
    // Decided on both sides: a pull request that deletes or unpublishes the only published unit is still checked.
    const project = loadProject({
      root,
      logger,
      ...(prepared.options.policy.publish ? { publish: prepared.options.policy.publish } : {}),
    });
    const units = [...project.workflows.values(), ...project.actions.values()];
    if (!units.some((u) => isPublished(u, prepared.options.policy))) {
      return { note: 'impact: no published workflows or actions (see impact.publish)' };
    }
  }
  return { options: prepared.options };
}

function pluginsAllowed(value: 'auto' | 'true' | 'false'): boolean {
  if (value !== 'auto') return value === 'true';
  return !UNTRUSTED_EVENTS.has(process.env.GITHUB_EVENT_NAME ?? '');
}

const slug = (s: string) =>
  s
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'root';

/** Every output starts out defined, so steps that read them after an early failure see sane values. */
function initOutputs(): void {
  for (const k of ['errors', 'warnings', 'infos', 'suppressed', 'findings', 'breaking']) core.setOutput(k, 0);
  core.setOutput('drift', 'false');
  core.setOutput('exit-code', 2);
  for (const k of ['report-json', 'report-sarif', 'patch', 'artifact-id']) core.setOutput(k, '');
}

function formatRecord(r: LogRecord, withScope: boolean): string {
  const data = r.data && Object.keys(r.data).length ? ` ${JSON.stringify(r.data)}` : '';
  return `${withScope ? `[${r.scope}] ` : ''}${r.message}${data}`;
}

/** How deep the open log groups are, and the title of a group that opens with its first line. */
interface Groups {
  depth: number;
  pending?: string;
}

/**
 * Log lines go to the step log, never to annotations (findings are reported separately). Debug records use
 * `core.debug` when the runner shows them (step debug logging); when only the `debug` input asked for them they
 * would be hidden there, so they are printed as ordinary lines instead.
 */
function actionsSink(runnerDebug: boolean, groups: Groups): LogSink {
  // A group waiting for its first line (see `loggedGroup` in run()) opens with it.
  const open = () => {
    if (groups.pending === undefined) return;
    core.startGroup(groups.pending);
    delete groups.pending;
  };
  return {
    write(r) {
      open();
      switch (r.level) {
        case 'debug':
        case 'trace':
          if (runnerDebug) core.debug(formatRecord(r, true));
          else core.info(neutralizeWorkflowCommands(`${r.level}: ${formatRecord(r, true)}`));
          return;
        case 'info':
          core.info(neutralizeWorkflowCommands(formatRecord(r, false)));
          return;
        case 'warn':
          core.info(neutralizeWorkflowCommands(`warning: ${formatRecord(r, false)}`));
          return;
        case 'error':
          core.info(neutralizeWorkflowCommands(`error: ${formatRecord(r, false)}`));
          return;
      }
    },
    // The log viewer cannot nest groups; inside one, a nested group is just a heading line.
    group(title) {
      open();
      if (groups.depth++ === 0) core.startGroup(title);
      else core.info(title);
    },
    groupEnd() {
      if (--groups.depth === 0) core.endGroup();
    },
  };
}

const toPosix = (p: string) => p.split(sep).join('/');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function annotate(f: Finding, prefix: string): void {
  const { level, message, ...props } = githubAnnotation(f, { pathPrefix: prefix });
  if (level === 'error') core.error(message, props);
  else if (level === 'warning') core.warning(message, props);
  else core.notice(message, props);
}

function writeReport(workspace: string, file: string, content: string): string {
  const abs = resolve(workspace, file);
  // Never through a symlink in the checkout, which a pull request could have committed.
  assertSafeWritePath(abs, [workspace]);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  const shown = toPosix(relative(workspace, abs));
  core.info(`wrote ${shown.startsWith('..') ? abs : shown}`);
  return abs;
}

function artifactReadme(plan: ContractPlan, artifactName: string, runId: string | undefined): string {
  const download = runId
    ? `gh run download ${runId} -n ${artifactName}`
    : `# download the "${artifactName}" artifact from the workflow run and unzip it here`;
  return [
    '# Regenerated workflow contracts',
    '',
    `flowpact check found that the locked contracts no longer match the workflows (${plan.counts.create} new, ${plan.counts.update} changed, ${plan.counts.delete} removed, ${plural(plan.breaking, 'breaking change')}).`,
    '',
    `This artifact holds \`${PATCH_FILE}\`, a patch that brings the contracts up to date, and, in this`,
    `folder, the regenerated contract files themselves (removed contracts are only in the patch).`,
    '',
    'To apply it, from the root of your repository:',
    '',
    '```sh',
    download,
    `git apply --index ${PATCH_FILE}`,
    `rm -r ${PATCH_FILE} ${ARTIFACT_DIR}`,
    '```',
    '',
    'Review the changes (breaking ones are listed in the job summary), then commit them.',
    'If you can run flowpact locally, `flowpact generate` produces the same files.',
    '',
  ].join('\n');
}

interface DriftArtifact {
  dir: string;
  patch: string;
  uploaded?: { id: number };
}

/** Writes the regenerated contracts and a patch to a temp folder and uploads them as an artifact. */
async function driftArtifact(
  plan: ContractPlan,
  prefix: string,
  inputs: Inputs,
  runId: string | undefined,
): Promise<DriftArtifact> {
  // One folder per step (and project), so several flowpact steps in a job never overwrite each other's patch.
  const name = `flowpact-contracts-artifact-${slug(process.env.GITHUB_ACTION ?? 'flowpact')}-${slug(prefix)}`;
  const runnerTemp = process.env.RUNNER_TEMP;
  let dir: string;
  if (runnerTemp) {
    // The runner's per-job folder: a predictable path later steps can read (the summary names it).
    dir = join(runnerTemp, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  } else {
    // Outside Actions the shared temp folder is world-writable: a fresh, private folder, never a predictable path.
    dir = mkdtempSync(join(tmpdir(), `${name}-`));
  }
  // Paths in the patch and the artifact are relative to the repository, not to working-directory.
  const repoPlan: ContractPlan = {
    ...plan,
    entries: plan.entries.map((e) => ({ ...e, file: inRepository(e.file, prefix) })),
  };
  const patch = join(dir, PATCH_FILE);
  writeFileSync(patch, contractPatch(repoPlan));
  const contracts = writeContracts(dir, repoPlan, join(dir, ARTIFACT_DIR));
  writeFileSync(join(dir, ARTIFACT_DIR, 'README.md'), artifactReadme(plan, inputs.artifactName, runId));
  const files = [
    patch,
    join(dir, ARTIFACT_DIR, 'README.md'),
    ...contracts.map((f) => join(dir, ARTIFACT_DIR, f)),
  ];
  core.info(`wrote ${PATCH_FILE} and ${plural(contracts.length, 'contract file')} to ${dir}`);
  const out: DriftArtifact = { dir, patch };
  if (!inputs.uploadContracts) return out;
  try {
    const res = await uploadArtifact(inputs.artifactName, files, dir, {
      ...(inputs.retentionDays > 0 ? { retentionDays: inputs.retentionDays } : {}),
    });
    core.info(`uploaded artifact ${inputs.artifactName} (id ${res.id})`);
    out.uploaded = { id: res.id };
  } catch (err) {
    const message = (err as Error).message;
    const conflict = /409|conflict|already exists/i.test(message)
      ? ' Another step or matrix job in this run already uploaded an artifact with this name: set a unique `artifact-name`.'
      : '';
    core.warning(`Could not upload the ${inputs.artifactName} artifact: ${message}.${conflict}`);
  }
  return out;
}

function failureMessage(result: AnalysisResult, inputs: Inputs, drift: DriftArtifact | undefined): string {
  const s = result.summary;
  const counted =
    inputs.failOn === 'warning'
      ? `${plural(s.errors, 'error')} and ${plural(s.warnings, 'warning')}`
      : plural(s.errors, 'error');
  let message = `flowpact found ${counted}`;
  const plan = result.contracts;
  if (plan?.drift) {
    message += `; the workflow contracts drifted (${plural(plan.breaking, 'breaking change')})`;
    message += drift?.uploaded
      ? ` — apply ${PATCH_FILE} from the ${inputs.artifactName} artifact (see the job summary) or run flowpact generate`
      : ' — run flowpact generate and commit the result';
  }
  return `${message}.`;
}

/** The job summary, shortened step by step until it fits GitHub's per-step limit. */
export function summaryWithinLimit(result: AnalysisResult, opts: MarkdownOptions): string {
  const attempts: MarkdownOptions[] = [
    opts,
    { ...opts, includeGraph: false },
    { ...opts, includeGraph: false, maxFindings: Math.min(opts.maxFindings ?? 50, 20) },
    { ...opts, includeGraph: false, maxFindings: 5 },
  ];
  for (const attempt of attempts) {
    const md = renderMarkdown(result, attempt);
    if (Buffer.byteLength(md) <= SUMMARY_LIMIT) {
      if (attempt !== opts)
        core.warning('The job summary was shortened to stay within GitHub’s 1 MiB limit.');
      return md;
    }
  }
  core.warning('The job summary is too large even when shortened; see the report files instead.');
  return `## flowpact ${opts.title ?? ''}\n\nThe report is too large for a job summary. Use the \`report-json\` or \`report-sarif\` inputs.\n`;
}

export async function run(): Promise<void> {
  let debug = false;
  initOutputs();
  try {
    const inputs = readInputs();
    const envLevel = resolveLogLevel({}, process.env);
    debug = inputs.debug || core.isDebug() || envLevel !== 'info';
    const level: LogLevel = debug ? (envLevel === 'trace' ? 'trace' : 'debug') : 'info';
    const groups: Groups = { depth: 0 };
    const logger = createLogger({ level, sink: actionsSink(core.isDebug(), groups) });
    const group = async <T>(title: string, fn: () => Promise<T> | T): Promise<T> => {
      groups.depth++;
      try {
        return await core.group(title, async () => fn());
      } finally {
        groups.depth--;
      }
    };
    // A group that opens with the first record logged in it, so that a stage with nothing to say (impact mode off or
    // skipped) prints no empty group.
    const loggedGroup = <T>(title: string, fn: () => T): T => {
      groups.depth++;
      groups.pending = title;
      try {
        return fn();
      } finally {
        groups.depth--;
        if (groups.pending === undefined) core.endGroup();
        delete groups.pending;
      }
    };

    core.info(bannerText());
    const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
    const root = resolve(workspace, inputs.workingDirectory);
    const rel = toPosix(relative(workspace, root));
    const prefix = rel === '' || rel === '.' ? '' : rel;

    const loaded: LoadedConfig = loadConfig(root, inputs.config ? resolve(root, inputs.config) : undefined, {
      ...(inputs.baseConfig ? { base: inputs.baseConfig } : {}),
    });
    core.info(
      `mode ${inputs.mode} · root ${prefix || '.'} · config ${loaded.file ?? '(defaults)'}${loaded.base ? ` · base ${loaded.base.file}` : ''}`,
    );
    // Why plugins from the checkout do not run, when they do not: the plugins input, or an untrusted event.
    const checkoutPluginsOff =
      core.getInput('plugins').trim().toLowerCase() === 'false'
        ? 'the plugins input is false'
        : `plugins run code from the checkout and are disabled on ${process.env.GITHUB_EVENT_NAME} events; set the plugins input to true to allow them`;
    // A plugin given with the plugin input runs whatever the plugins input says, unless it is a file in the checkout
    // while plugins from the checkout may not run.
    const inCheckout = (p: string) => pathInside(workspace, p) || pathInside(root, p);
    const extraPlugins = inputs.extraPlugins.filter((p) => inputs.plugins || !inCheckout(p));
    const skippedPlugins = inputs.extraPlugins.filter((p) => !extraPlugins.includes(p));
    if (skippedPlugins.length) {
      const names = skippedPlugins.map((p) => toPosix(relative(workspace, p))).join(', ');
      core.warning(`Not loading the plugin input's ${names} from the checkout: ${checkoutPluginsOff}.`);
    }
    // With several projects (working-directory), give each its own artifact unless a name was set explicitly.
    if (!core.getInput('artifact-name').trim() && prefix)
      inputs.artifactName = `flowpact-contracts-${slug(prefix)}`;
    if (loaded.config.plugins.length && !inputs.plugins)
      core.warning(
        `Not loading ${loaded.config.plugins.length} plugin(s) from the config: ${checkoutPluginsOff}.`,
      );

    const impact = loggedGroup('flowpact: impact baseline', () =>
      impactSetup(root, loaded.config, inputs.config || undefined, loaded.base, inputs, logger),
    );
    if (impact.note) core.info(impact.note);

    const result = await group(`flowpact ${inputs.mode}: analyze`, async () => {
      const registry = createRegistry();
      if (inputs.plugins) await loadPlugins(root, loaded.config, registry, logger);
      if (extraPlugins.length)
        await loadPlugins(root, { ...loaded.config, plugins: extraPlugins }, registry, logger);
      return analyze({
        root,
        config: loaded.config,
        ...(inputs.paths.length ? { paths: inputs.paths } : {}),
        ...(loaded.file ? { configFile: loaded.file } : {}),
        ...(loaded.text !== undefined ? { configText: loaded.text } : {}),
        ...(loaded.overrideLocs ? { overrideLocs: loaded.overrideLocs } : {}),
        logger,
        registry,
        checkContracts: inputs.mode === 'check',
        ...(impact.options ? { impact: impact.options } : {}),
      });
    });
    if (result.unloadedRules?.length) {
      core.warning(
        `Ignoring config entries for rules that are not loaded: ${result.unloadedRules.join('; ')}`,
      );
    }
    const s = result.summary;
    const missing = result.project.missingTargets ?? [];
    if (missing.length) {
      core.setFailed(`paths not found under ${prefix || '.'}: ${missing.join(', ')}`);
      return;
    }
    if (inputs.paths.length && result.project.targets.size === 0 && !result.project.wholeRepository) {
      core.setFailed(
        `None of the paths is a workflow (.github/workflows/*.yml) or an action (action.yml): ${inputs.paths.join(', ')}`,
      );
      return;
    }
    if (s.workflows === 0 && s.actions === 0) {
      core.setFailed(
        `No workflows found under ${prefix || '.'}/.github/workflows. Set working-directory to the repository that holds them.`,
      );
      return;
    }

    if (inputs.annotations) for (const f of result.findings) annotate(f, prefix);

    const runId = process.env.GITHUB_RUN_ID || undefined;
    const plan = result.contracts;
    const drift = plan?.drift
      ? await group('flowpact: contract drift artifact', () => driftArtifact(plan, prefix, inputs, runId))
      : undefined;

    const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_SHA } = process.env;
    const markdownOptions: MarkdownOptions = {
      title: `flowpact ${inputs.mode}`,
      maxFindings: inputs.maxFindings,
      includeGraph: inputs.summaryGraph,
      ...(GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_SHA
        ? // Links are `<repo>/blob/<sha>/<file>`; files are relative to working-directory, so it joins the sha.
          {
            repoUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`,
            sha: prefix ? `${GITHUB_SHA}/${prefix}` : GITHUB_SHA,
          }
        : {}),
      ...(drift?.uploaded
        ? { artifact: { name: inputs.artifactName, ...(runId ? { runId } : {}), patchFile: PATCH_FILE } }
        : {}),
    };
    const markdown = () => renderMarkdown(result, markdownOptions);

    if (inputs.summary) {
      try {
        await core.summary.addRaw(summaryWithinLimit(result, markdownOptions)).write();
      } catch (err) {
        core.warning(`Could not write the job summary: ${(err as Error).message}`);
      }
    }

    const reports: { json?: string; sarif?: string } = {};
    if (inputs.reportJson || inputs.reportSarif || inputs.reportMarkdown) {
      await group('flowpact: reports', () => {
        if (inputs.reportJson) reports.json = writeReport(workspace, inputs.reportJson, renderJson(result));
        if (inputs.reportSarif)
          reports.sarif = writeReport(
            workspace,
            inputs.reportSarif,
            renderSarif(result, { pathPrefix: prefix }),
          );
        if (inputs.reportMarkdown) writeReport(workspace, inputs.reportMarkdown, markdown());
      });
    }

    const exitCode = exitCodeFor(s, inputs.failOn);
    core.setOutput('errors', s.errors);
    core.setOutput('warnings', s.warnings);
    core.setOutput('infos', s.infos);
    core.setOutput('suppressed', s.suppressed);
    core.setOutput('findings', s.total);
    core.setOutput('drift', plan?.drift ? 'true' : 'false');
    core.setOutput('breaking', plan?.breaking ?? 0);
    core.setOutput('exit-code', exitCode);
    core.setOutput('report-json', reports.json ?? '');
    core.setOutput('report-sarif', reports.sarif ?? '');
    core.setOutput('patch', drift?.patch ?? '');
    core.setOutput('artifact-id', drift?.uploaded?.id ?? '');
    core.setOutput('required-impact', result.impact?.verdict.required ?? '');
    core.setOutput('declared-impact', result.impact?.verdict.declared?.level ?? '');
    core.setOutput('impact-ok', result.impact ? String(result.impact.verdict.ok) : '');

    core.info(
      `flowpact ${inputs.mode}: ${plural(s.errors, 'error')}, ${plural(s.warnings, 'warning')}, ${s.infos} info, ${s.suppressed} suppressed · ${plural(s.workflows, 'workflow')} · ${result.durationMs} ms`,
    );
    if (exitCode !== 0) core.setFailed(failureMessage(result, inputs, drift));
  } catch (err) {
    if (err instanceof ConfigError) {
      const where = err.file ? ` (${err.file})` : '';
      core.setFailed([`${err.message}${where}`, ...err.issues.map((i) => `  - ${i}`)].join('\n'));
    } else if (err instanceof InputError || err instanceof UnsafePathError) {
      core.setFailed(err.message);
    } else {
      const e = err instanceof Error ? err : new Error(String(err));
      core.setFailed(debug && e.stack ? e.stack : `${e.message} (set the debug input for a stack trace)`);
    }
  }
}
