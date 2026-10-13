/** `lint`, `check` and `impact`: the analysis, and the reports rendered from it. */
import { resolve } from 'node:path';
import { neutralizeWorkflowCommands } from '@ciatlas/core';
import {
  type AnalysisResult,
  type AnalyzeOptions,
  analyze,
  contractPatch,
  exitCodeFor,
  githubEvent,
  IMPACT_CODES,
  type ImpactLevel,
  type JsonReport,
  type PreparedImpact,
  prepareImpact,
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
import { bool, loadRegistry, oneOf, type Session, stringList } from './session';
import { checkNotEmpty, checkTargets } from './targets';
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
}

export interface PrettyOptions extends TextOptions {
  /** Do not list info-level findings (they are still counted). */
  hideInfo?: boolean;
}

export interface Analysis {
  /** The JSON report (schema v1): what `--format json` prints, parsed. */
  readonly report: JsonReport;
  /** What the CLI prints as `impact: …` lines: impact mode skipped, or notes about its baseline. */
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
   * Impact mode is skipped (on `merge_group`). Returning true stops before the analysis, and `runReport` returns
   * undefined.
   */
  impactSkipped?(reason: string): boolean;
  /** The analysis ran, before its paths are checked; `notes` are impact mode's notes about its baseline. */
  analyzed?(notes: string[]): void;
}

/** The baseline and the declaration for impact mode; read from the pull request when running in GitHub Actions. */
function setupImpact(session: Session, flags: ImpactFlags): PreparedImpact {
  const { root, loaded, logger } = session;
  return attempt(() =>
    prepareImpact(
      root,
      loaded.config,
      {
        ...(flags.base ? { base: flags.base } : {}),
        ...(flags.expect ? { expect: flags.expect } : {}),
        ...(flags.title !== undefined ? { title: flags.title } : {}),
        ...(flags.labels !== undefined ? { labels: flags.labels } : {}),
        ...(process.env.GITHUB_ACTIONS === 'true' ? { event: githubEvent() } : {}),
        ...(loaded.file ? { configPath: loaded.file } : {}),
        // A base config that is a file of the repository stays out of the baseline (core decides from its path).
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
  expect: ImpactLevel | undefined,
  labels: string[] | undefined,
): PreparedImpact | undefined {
  if (command !== 'impact' && !bool('impact', options.impact)) return undefined;
  return setupImpact(session, {
    ...(options.base !== undefined ? { base: options.base } : {}),
    ...(expect ? { expect } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(labels ? { labels } : {}),
  });
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
): Partial<AnalyzeOptions> {
  return {
    ...(options.now ? { now: options.now } : {}),
    paths,
    validateSchema: command === 'impact' ? false : bool('schema', options.schema) !== false,
    checkContracts: command === 'check',
    ...onlyRules(command, only),
    ...(impact && 'options' in impact ? { impact: impact.options } : {}),
  };
}

/** Runs `lint`, `check` or `impact`; undefined only when a hook stopped it. */
export async function runReport(
  session: Session,
  command: ReportCommand,
  options: ReportOptions = {},
  hooks: ReportHooks = {},
): Promise<Analysis | undefined> {
  const paths = stringList('paths', options.paths) ?? [];
  const only = stringList('only', options.only);
  const labels = stringList('labels', options.labels);
  const expect = oneOf('expect', options.expect, IMPACT_LEVELS);
  if (options.now !== undefined && !(options.now instanceof Date)) throw usage('now must be a Date');
  const { root, loaded, logger } = session;
  const notes: string[] = [];
  const impact = impactFor(session, command, options, expect, labels);
  if (impact && 'skip' in impact) {
    notes.push(`impact: skipped (${impact.skip})`);
    if (hooks.impactSkipped?.(impact.skip)) return undefined;
  }
  const registry = await loadRegistry(session);
  const result: AnalysisResult = attempt(() =>
    analyze({
      root,
      config: loaded.config,
      ...(loaded.file ? { configFile: loaded.file } : {}),
      ...(loaded.text !== undefined ? { configText: loaded.text } : {}),
      ...(loaded.overrideLocs ? { overrideLocs: loaded.overrideLocs } : {}),
      logger,
      registry,
      ...commandOptions(command, options, paths, only, impact),
    }),
  );
  const baseline = impact && 'notes' in impact ? impact.notes.map((n) => `impact: ${n}`) : [];
  notes.push(...baseline);
  hooks.analyzed?.(baseline);
  // In impact mode, a path the change removed (one that names a workflow or action of the baseline) is not missing.
  checkTargets(result.project, paths, root, result.impact?.scope?.fromBaseline);
  if (command !== 'impact') checkNotEmpty(result.summary, root);
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
