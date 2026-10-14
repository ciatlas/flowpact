/** `lint`, `check` and `impact`: the analysis, and the reports rendered from it. */
import { resolve } from 'node:path';
import { neutralizeWorkflowCommands, nodeFileSystem } from '@ciatlas/core';
import {
  type AnalysisResult,
  type AnalyzeOptions,
  contractPatch,
  exitCodeFor,
  fetchMissingRemotes,
  followsPullRequest,
  githubEvent,
  IMPACT_CODES,
  type ImpactLevel,
  type JsonReport,
  type PreparedImpact,
  prepareImpact,
  readRemotesLock,
} from '@flowpact/lint';
import {
  type GithubAnnotation,
  githubAnnotation,
  type MarkdownOptions,
  renderGithub,
  renderJson,
  renderMarkdown,
  renderPretty,
  renderSarif,
} from '@flowpact/reporters';
import { attempt, usage } from './errors';
import { apiUrlFromEnv, tokenFor } from './remotes';
import { analyzeSession, bool, oneOf, type Session, stringList } from './session';
import { checkNotEmpty, checkTargets, removedElsewhere } from './targets';
import { renderOptions, type TextOptions } from './text';

export type ReportCommand = 'lint' | 'check' | 'impact';
export type FailOn = 'error' | 'warning' | 'never';

const FAIL_ON: readonly FailOn[] = ['error', 'warning', 'never'];
const IMPACT_LEVELS: readonly ImpactLevel[] = ['none', 'patch', 'minor', 'major'];

/** The flags of impact mode: `--base`, `--expect`, `--title` and `--labels`. */
export interface ImpactFlags {
  /** Baseline ref. Default: the pull request's base in GitHub Actions, else origin/HEAD. */
  base?: string;
  /** The declared impact. Default: read from `title`, `labels` or the pull request. */
  expect?: ImpactLevel;
  /** Pull request title to read the declared impact from (Conventional Commits). */
  title?: string;
  /** Pull request labels (semver:major, semver:minor, …). */
  labels?: string[];
}

export interface ReportOptions extends ImpactFlags {
  /**
   * Workflow and action files or directories to report on, relative to the root; impact mode judges only the published
   * ones within them. Default: all.
   */
  paths?: string[];
  /** Rule codes or names to run. */
  only?: string[];
  /** Validate against GitHub's workflow schema. Default: true. */
  schema?: boolean;
  /** Also check the release impact (`--impact`). */
  impact?: boolean;
  /** Clock for override expiry (the CLI's `FLOWPACT_NOW`). Default: now. */
  now?: Date;
  /**
   * Fetch the interfaces of the remote references the remote interfaces lockfile lacks, for this run (`--fetch-remotes`);
   * nothing is written. Default: false.
   */
  fetchRemotes?: boolean;
}

export interface PrettyOptions extends TextOptions {
  /** Do not list info-level findings (they are still counted). */
  hideInfo?: boolean;
}

export interface Analysis {
  /** The JSON report (schema v1): what `--format json` prints, parsed. */
  readonly report: JsonReport;
  /**
   * What the CLI prints as `impact: …` lines: impact mode skipped, notes about its baseline and how it graded, and the
   * paths it does not refuse though they name no workflow or action.
   */
  readonly notes: string[];
  /** The comparison with the locked contracts (`check` only). */
  readonly contracts?: { drift: boolean; breaking: number; patch(): string | undefined };
  /** Impact mode's verdict, as in the JSON report, when it ran. */
  readonly impact?: JsonReport['impact'];
  exitCode(failOn?: FailOn): 0 | 1;
  annotations(options?: { pathPrefix?: string }): GithubAnnotation[];
  /** The annotations as workflow commands (`--format github`), every value escaped. */
  github(options?: { pathPrefix?: string }): string;
  sarif(options?: { pathPrefix?: string }): string;
  markdown(options?: MarkdownOptions): string;
  json(options?: { includeGraph?: boolean }): string;
  pretty(options?: PrettyOptions): string;
}

/** Where the CLI prints, in order, what the API returns in `notes`. */
export interface ReportHooks {
  /**
   * Impact mode is skipped: on `merge_group`, before the analysis, or after it when the paths hold nothing to grade or
   * report on. Returning true stops there, and `runReport` returns undefined.
   */
  impactSkipped?(reason: string): boolean;
  /**
   * The analysis ran, before its paths are checked; `notes` are impact mode's notes about its baseline and how it
   * graded, and about the paths it does not refuse though they name no workflow or action of the working tree.
   */
  analyzed?(notes: string[]): void;
  /**
   * Where else a path the working tree lacks may be meant (the CLI: relative to the working directory). Impact mode
   * takes it from there when the baseline has a workflow or action within it there and not under the root.
   */
  elsewhere?(path: string): string | undefined;
}

/** The baseline and the declaration for impact mode; read from the pull request when running in GitHub Actions. */
function setupImpact(session: Session, flags: ImpactFlags, paths: string[]): PreparedImpact {
  const { root, loaded, logger } = session;
  return attempt(() =>
    prepareImpact(
      root,
      loaded.config,
      {
        ...(paths.length ? { paths } : {}),
        ...(flags.base ? { base: flags.base } : {}),
        ...(flags.expect ? { expect: flags.expect } : {}),
        ...(flags.title !== undefined ? { title: flags.title } : {}),
        ...(flags.labels !== undefined ? { labels: flags.labels } : {}),
        ...(process.env.GITHUB_ACTIONS === 'true' ? { event: githubEvent() } : {}),
        ...(loaded.file ? { configPath: loaded.file } : {}),
        // A base config the pull request's commits can change stays out of the baseline's impact settings (impact mode
        // follows the path through git: the commits, their submodules and the symbolic links on the way).
        ...(loaded.base
          ? { baseConfig: loaded.base.data, baseConfigFile: resolve(process.cwd(), loaded.base.file) }
          : {}),
      },
      logger,
    ),
  );
}

/** Impact mode's baseline and declaration, when the command or `--impact` asks for impact mode. */
function impactFor(
  session: Session,
  command: ReportCommand,
  options: ReportOptions,
  declared: { expect: ImpactLevel | undefined; labels: string[] | undefined },
  paths: string[],
): PreparedImpact | undefined {
  if (command !== 'impact' && !bool('impact', options.impact)) return undefined;
  const { expect, labels } = declared;
  return setupImpact(
    session,
    {
      ...(options.base !== undefined ? { base: options.base } : {}),
      ...(expect ? { expect } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(labels ? { labels } : {}),
    },
    paths,
  );
}

/** Whether this run usually follows a pull request's run, which has the baseline (`merge_group`, `push` in Actions). */
const afterPullRequest = () =>
  process.env.GITHUB_ACTIONS === 'true' && followsPullRequest(process.env.GITHUB_EVENT_NAME);

/**
 * The paths that name no workflow or action of the working tree yet are not refused, and notes about them: in impact
 * mode, what the change removed; when impact mode was asked for but skipped on `merge_group` or `push`, every such path
 * that would be refused (one the working tree lacks, or one that holds no workflow or action, such as a removed
 * action's directory that keeps its README), since without a baseline a path the change removed cannot be told from a
 * mistake, and a pull request's run, which has one, usually came first (a new branch's first push comes before any).
 * Anywhere else, a skipped impact mode refuses them.
 */
function unrefused(
  result: AnalysisResult,
  impact: PreparedImpact | undefined,
): { paths: string[]; notes: string[] } {
  if (!impact || !('skip' in impact) || !afterPullRequest())
    return { paths: result.removedPaths ?? [], notes: [] };
  const { missingTargets: missing = [], ignoredTargets = [], targets, wholeRepository } = result.project;
  // Beside a path that names a workflow or action, one that holds none is not refused anyway.
  const empty = targets.size || wholeRepository ? [] : ignoredTargets;
  const note = (what: string, paths: string[]) =>
    paths.length
      ? [
          `impact: ${what}, not refused while impact mode is skipped (the change may have removed them): ${paths.join(', ')}`,
        ]
      : [];
  return {
    paths: [...missing, ...empty],
    notes: [...note('paths not found', missing), ...note('paths without a workflow or action', empty)],
  };
}

/** The rules to run: as `--only` says; impact mode alone runs the impact rules. */
function onlyRules(command: ReportCommand, only: string[] | undefined): { only?: string[] } {
  if (command === 'impact' && !only) return { only: [...IMPACT_CODES] };
  return only ? { only } : {};
}

/** What analyze() runs with for `command`, besides the session's root, config, logger and rules. */
function commandOptions(
  command: ReportCommand,
  options: ReportOptions,
  paths: string[],
  only: string[] | undefined,
  impact: PreparedImpact | undefined,
  fetched: AnalyzeOptions['fetchedRemotes'],
): Partial<AnalyzeOptions> {
  return {
    ...(options.now ? { now: options.now } : {}),
    ...(fetched ? { fetchedRemotes: fetched } : {}),
    paths,
    validateSchema: command === 'impact' ? false : bool('schema', options.schema) !== false,
    checkContracts: command === 'check',
    ...onlyRules(command, only),
    ...(impact && 'options' in impact ? { impact: impact.options } : {}),
  };
}

/** The remote interfaces the lockfile lacks, fetched for this run; a reference that cannot be fetched is a warning. */
async function fetchRemotesFor(session: Session): Promise<AnalyzeOptions['fetchedRemotes']> {
  const { root, logger } = session;
  const fs = nodeFileSystem(root);
  const apiUrl = apiUrlFromEnv();
  const token = tokenFor(apiUrl, undefined);
  const r = await logger.time('fetch remote interfaces', () =>
    fetchMissingRemotes(root, fs, readRemotesLock(fs).lock, { apiUrl, ...(token ? { token } : {}) }),
  );
  for (const f of r.failed) logger.warn(`remote interface not fetched: ${f.ref}: ${f.error}`);
  return r.remotes;
}

/** The options `runReport` checks before it runs: paths, rules, labels, the declared impact and the clock. */
function reportInputs(options: ReportOptions) {
  if (options.now !== undefined && !(options.now instanceof Date)) throw usage('now must be a Date');
  return {
    given: stringList('paths', options.paths) ?? [],
    only: stringList('only', options.only),
    labels: stringList('labels', options.labels),
    expect: oneOf('expect', options.expect, IMPACT_LEVELS),
  };
}

/** Notes that impact mode is skipped; true when a hook stops the run there. */
function skipped(reason: string, notes: string[], hooks: ReportHooks): boolean {
  notes.push(`impact: skipped (${reason})`);
  return hooks.impactSkipped?.(reason) === true;
}

/**
 * Impact mode's notes once the analysis ran: about its baseline, about how it graded, and about the paths it does not
 * refuse.
 */
function analyzedNotes(
  impact: PreparedImpact | undefined,
  result: AnalysisResult,
  unrefusedNotes: string[],
): string[] {
  return [...(impact && 'notes' in impact ? impact.notes : []), ...(result.impactNotes ?? [])]
    .map((n) => `impact: ${n}`)
    .concat(unrefusedNotes);
}

/** Runs `lint`, `check` or `impact`; undefined only when a hook stopped it. */
export async function runReport(
  session: Session,
  command: ReportCommand,
  options: ReportOptions = {},
  hooks: ReportHooks = {},
): Promise<Analysis | undefined> {
  const { given, only, labels, expect } = reportInputs(options);
  const { root } = session;
  const notes: string[] = [];
  const impact = impactFor(session, command, options, { expect, labels }, given);
  if (impact && 'skip' in impact && skipped(impact.skip, notes, hooks)) return undefined;
  const paths = removedElsewhere(
    given,
    impact && 'options' in impact ? impact.options.base : undefined,
    root,
    hooks.elsewhere,
  );
  const fetched = bool('fetchRemotes', options.fetchRemotes) ? await fetchRemotesFor(session) : undefined;
  const result = await analyzeSession(
    session,
    commandOptions(command, options, paths, only, impact, fetched),
  );
  // In impact mode, a path the change removed (one that names a workflow or action of the baseline) is not missing.
  const accepted = unrefused(result, impact);
  const analyzed = analyzedNotes(impact, result, accepted.notes);
  notes.push(...analyzed);
  hooks.analyzed?.(analyzed);
  checkTargets(result.project, paths, root, accepted.paths);
  if (command !== 'impact') checkNotEmpty(result.summary, root);
  if (result.impactSkipped && skipped(result.impactSkipped, notes, hooks)) return undefined;
  return analysisOf(result, notes);
}

/** The result of an analysis, and every report rendered from it. */
function analysisOf(result: AnalysisResult, notes: string[]): Analysis {
  let report: JsonReport | undefined;
  const plan = result.contracts;
  return {
    get report() {
      // Parsed from the JSON text, so it is exactly what `--format json` prints and shares nothing with the engine.
      report ??= JSON.parse(renderJson(result)) as JsonReport;
      return report;
    },
    notes,
    ...(plan
      ? {
          contracts: {
            drift: plan.drift,
            breaking: plan.breaking,
            patch: () => (plan.drift ? contractPatch(plan) : undefined),
          },
        }
      : {}),
    get impact() {
      return this.report.impact;
    },
    exitCode: (failOn = 'error') =>
      exitCodeFor(result.summary, oneOf('failOn', failOn, FAIL_ON) ?? 'error') as 0 | 1,
    annotations: ({ pathPrefix } = {}) =>
      result.findings.map((f) => githubAnnotation(f, pathPrefix ? { pathPrefix } : {})),
    // Workflow commands on purpose: every value in them is escaped, so a finding cannot start a command of its own.
    github: ({ pathPrefix } = {}) => renderGithub(result, pathPrefix ? { pathPrefix } : {}),
    sarif: ({ pathPrefix } = {}) => renderSarif(result, pathPrefix ? { pathPrefix } : {}),
    // Text embeds names from the analyzed YAML: none of it may become a workflow command in a CI log (the CLI's
    // stdout and report files guarantee the same).
    markdown: (options = {}) => neutralizeWorkflowCommands(renderMarkdown(result, options)),
    json: ({ includeGraph } = {}) => renderJson(result, { includeGraph: Boolean(includeGraph) }),
    pretty: (options = {}) =>
      neutralizeWorkflowCommands(
        renderPretty(result, { ...renderOptions(options), hideInfo: Boolean(options.hideInfo) }),
      ),
  };
}
