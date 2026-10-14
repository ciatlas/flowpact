import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import {
  compareLoc,
  declaredMatrix,
  detectRepository,
  didYouMean,
  escapeControl,
  expandMatrix,
  type FileSystem,
  type JobDecl,
  type Loc,
  type Logger,
  loadProject,
  type MatrixExpansion,
  matchesPattern,
  nodeFileSystem,
  type Project,
  ProjectIndex,
  SourceFile,
  silentLogger,
  typoDistance,
  type UnitDecl,
} from '@ciatlas/core';
import { ConfigError, defaultConfig, type FlowpactConfig, type Override } from './config';
import {
  type ContractPlan,
  type ContractPlanEntry,
  contractsInScope,
  pathHolds,
  planContracts,
  scopePlan,
} from './contracts';
import {
  computeImpact,
  type DeclaredInput,
  type ImpactLookAt,
  type ImpactNarrowed,
  type ImpactPaths,
  type ImpactPolicy,
  type ImpactResult,
  type ImpactScope,
} from './impact';
import { type RemotesLock, type RemotesLockRead, readRemotesLock, remoteInterfaces } from './remotes';
import { createRegistry, IMPACT_CODES } from './rules/index';
import { CODE_PATTERN, type RuleRegistry } from './rules/registry';
import type {
  Finding,
  OverrideUsage,
  ReportInput,
  RuleContext,
  RuleDefinition,
  Severity,
  SeveritySetting,
} from './rules/types';
import { type ToolMeta, toolMeta } from './version';

export interface AnalyzeOptions {
  root: string;
  paths?: string[];
  fs?: FileSystem;
  config?: FlowpactConfig;
  configFile?: string;
  registry?: RuleRegistry;
  logger?: Logger;
  validateSchema?: boolean;
  repository?: string;
  /** Only run these rules (codes or names). */
  only?: string[];
  /**
   * Remote interfaces fetched for this run (see `fetchMissingRemotes`), used where the lockfile has no entry for a
   * reference: the lockfile's own entries stand.
   */
  fetchedRemotes?: RemotesLock['remotes'];
  /**
   * Impact mode: the baseline's project (analysed from git), where it came from, what the pull request declares and
   * the policy (read from the baseline's config, so a pull request cannot relax its own check).
   */
  impact?: {
    base: ProjectIndex;
    baseline: ImpactResult['baseline'];
    declared: DeclaredInput;
    policy: ImpactPolicy;
    /** Files of the units the baseline published; their head versions are loaded even when nothing uses them. */
    publishedFiles?: string[];
    /**
     * The baseline config's `ignore`: impact mode does not grade a unit whose file both it and the pull request's own
     * `ignore` (the config's) match, so a pull request can neither ignore its way past the gate nor slip a change through
     * by taking a unit out of `ignore`. Without it, every published unit is graded.
     */
    ignore?: readonly string[];
    /**
     * A base config of the repository whose version in the baseline cannot be read (a submodule's commit the clone
     * lacks), so `ignore` lacks what it lists: the units only the pull request's `ignore` matches are graded, and the
     * note about them does not say that they are left out once the pull request is merged.
     */
    ignoreUnread?: string;
    /**
     * The pull request's `ignore` as its commits have it, where that differs from the config's: with a base config in a
     * submodule, at the commit the pull request records for it (`git submodule update --remote` checks out another).
     * A unit is left out only when this matches its file too, and it is what applies once the pull request is merged.
     */
    ignoreAfterMerge?: readonly string[];
    /**
     * Run only when the paths hold a published unit that `ignore` does not leave out, in the baseline or the working
     * tree (the action's `impact: auto`). Without paths, the caller decides that beforehand.
     */
    onlyIfPublished?: boolean;
  };
  /** Compare against the contracts in `.github/flowpact/` (`flowpact check`). */
  checkContracts?: boolean;
  /** Clock for override expiry; defaults to the current time. */
  now?: Date;
  /** Locations of `overrides[i]` in the config file (from `loadConfig`). */
  overrideLocs?: Loc[];
  /** Raw config text, so findings about the config can show a code frame. */
  configText?: string;
}

/** A finding that an override accepted. */
export interface SuppressedFinding extends Finding {
  override: { index: number; reason: string; expires?: string; owner?: string };
}

export interface Summary {
  errors: number;
  warnings: number;
  infos: number;
  total: number;
  workflows: number;
  actions: number;
  jobs: number;
  matrixCombinations: number;
  graph: { nodes: number; edges: number };
  byCode: Record<string, number>;
  byFile: Record<string, number>;
  /** Findings accepted by overrides (not counted above). */
  suppressed: number;
  /**
   * Findings not reported because they are about the internals of generated files (rules with
   * `generatedFiles: 'skip'`; not counted above).
   */
  skippedInGenerated: number;
}

export interface AnalysisResult {
  meta: ToolMeta & { root: string; configFile?: string; repository?: string };
  project: Project;
  index: ProjectIndex;
  findings: Finding[];
  summary: Summary;
  /** Effective severity per rule after config. */
  rules: { code: string; name: string; severity: SeveritySetting }[];
  /** Findings accepted by overrides, with the override that accepted them. */
  suppressed: SuppressedFinding[];
  /** Contract comparison (check mode only). */
  contracts?: ContractPlan;
  /** The config file, for code frames of FP9xx findings. */
  configSource?: SourceFile;
  /** Impact mode's changes and verdict, when it ran. */
  impact?: ImpactResult;
  /**
   * Why impact mode did not run although it was set up: nothing to grade or to report on, i.e. nothing published (within
   * the paths) is graded and no workflow or action of the working tree (within them) is left that `ignore` does not
   * leave out (say, only what the change removed, or an `ignore` that matches everything); or, with paths, nothing
   * published within them, when it runs only then (`onlyIfPublished`).
   */
  impactSkipped?: string;
  /**
   * Impact mode: the paths, as given, that name no workflow or action of the working tree but one of the baseline (or a
   * directory that held one): what the change removed. Such a path is not missing.
   */
  removedPaths?: string[];
  /** Notes about how impact mode graded, which callers print as `impact: <note>`. */
  impactNotes?: string[];
  /**
   * Config entries naming rules that are not loaded, such as the rules of a plugin that this run does not load. They
   * are ignored for this run, and logged as a warning.
   */
  unloadedRules?: string[];
  durationMs: number;
}

const compact = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '');

/** The first of the closest `candidates` that are at most `max` edits away by `distance`. */
function nearest(candidates: string[], distance: (c: string) => number, max: number): string | undefined {
  let best: { rule: string; d: number } | undefined;
  for (const rule of candidates) {
    const d = distance(rule);
    if (d <= max && (!best || d < best.d)) best = { rule, d };
  }
  return best?.rule;
}

/**
 * The prefix of a key read as a code: as CODE_PATTERN reads it (`AB12` in AB12602) when that reading is a code
 * (category digits are 1-9); otherwise the start before the first digit (`ACME` in ACME6011, which is no code).
 */
function keyPrefixOf(k: string): string | undefined {
  const asCode = CODE_PATTERN.exec(k.toUpperCase());
  return asCode && asCode[2] !== '0' ? asCode[1] : /^([a-z][a-z0-9]{1,9}?)\d/.exec(k)?.[1]?.toUpperCase();
}

/** The loaded rule name `key` (compacted: `k`) spells another way, or misspells by at most two edits. */
function nameTypo(names: string[], key: string, k: string): string | undefined {
  // camelCase and snake_case as dashes, so a typo is measured in the name's own words; a key without any separator
  // (`missingrequiredinptu`) is compared without them, one edit dearer.
  const spelled = key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  const undashed = !/[-_\s]/.test(key) && !/[a-z0-9][A-Z]/.test(key);
  return (
    names.find((n) => compact(n) === k) ??
    nearest(
      names,
      (n) =>
        Math.min(
          typoDistance(spelled, n),
          undashed ? typoDistance(k, compact(n)) + 1 : Number.POSITIVE_INFINITY,
        ),
      2,
    )
  );
}

/**
 * The loaded rule an unknown key is a typo of, if it is one:
 * - a key with the built-in `FP` prefix and a digit (`FP10l`, `fp-101`), or a built-in code with one character
 *   replaced or two swapped (`FPl01`, `FPO01`);
 * - a code one edit from a loaded code with the same prefix (`ACME610`, `AB12602`);
 * - another spelling of a loaded name (`unusedInput`, `unused_input`), or a name two edits from one (`unused-inptu`).
 * A code with another prefix (`AC201`, `DP201`, `FPX201` beside `FP201`) or a name that adds a word to a loaded one
 * (`no-secrets-inherit`, `secrets-inherit-banned`) belongs to a plugin.
 */
function typoOf(registry: RuleRegistry, key: string): { typo: boolean; rule?: string } {
  const k = compact(key);
  const rules = registry.all();
  const codes = rules.map((r) => r.code);
  const fromCode = (c: string) => typoDistance(k, c.toLowerCase());
  if (/^fp\d/.test(k)) {
    const rule = nearest(codes, fromCode, 1);
    return { typo: true, ...(rule ? { rule } : {}) };
  }
  const builtin = nearest(
    codes.filter((c) => /^FP\d/.test(c) && c.length === k.length),
    fromCode,
    1,
  );
  if (k.startsWith('fp') && builtin) return { typo: true, rule: builtin };
  const prefix = (code: string) => CODE_PATTERN.exec(code.toUpperCase())?.[1];
  const keyPrefix = keyPrefixOf(k);
  const code = nearest(
    codes.filter((c) => keyPrefix !== undefined && prefix(c) === keyPrefix),
    fromCode,
    1,
  );
  if (code) return { typo: true, rule: code };
  const rule = nameTypo(
    rules.map((r) => r.name),
    key,
    k,
  );
  return rule ? { typo: true, rule } : { typo: false };
}

/**
 * Sorts config references to unknown rules. A name may belong to the rule of a plugin that this run does not load (the
 * repository's plugins skipped, or organization rules that only a wrapper loads) and is tolerated — unless it uses the
 * built-in `FP` prefix or is a typo of a loaded rule.
 */
function triageUnknown(
  registry: RuleRegistry,
  key: string,
  path: string,
  out: { hard: string[]; tolerated: string[] },
) {
  const { typo, rule } = typoOf(registry, key);
  const issue = `${path}: unknown rule${rule ? ` (did you mean ${rule}?)` : ` "${key}"`}`;
  (typo ? out.hard : out.tolerated).push(issue);
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function resolveSeverities(
  registry: RuleRegistry,
  config: FlowpactConfig,
  opts: { logger?: Logger; unloaded?: string[] } = {},
): Map<string, SeveritySetting> {
  const out = new Map<string, SeveritySetting>();
  for (const rule of registry.all()) out.set(rule.code, rule.defaultSeverity);
  const unknown = { hard: [] as string[], tolerated: [] as string[] };
  for (const [key, setting] of Object.entries(config.rules)) {
    const rule = registry.get(key);
    if (!rule) {
      triageUnknown(registry, key, `rules.${key}`, unknown);
      continue;
    }
    out.set(rule.code, setting);
  }
  if (unknown.hard.length) throw new ConfigError('Config references unknown rules', undefined, unknown.hard);
  if (unknown.tolerated.length) {
    opts.logger?.warn(
      `config sets severities for rules that are not loaded: ${unknown.tolerated.join('; ')}`,
    );
    opts.unloaded?.push(...unknown.tolerated);
  }
  return out;
}

export function fingerprint(code: string, symbol: string | undefined, file: string, message: string): string {
  const normalized = message.replace(/\d+/g, '#');
  return createHash('sha1')
    .update(`${code}|${symbol ?? ''}|${file}|${normalized}`)
    .digest('hex')
    .slice(0, 16);
}

/** The config a run applies. */
function effectiveConfig(opts: AnalyzeOptions): FlowpactConfig {
  // A run without rules (generate, trace, graph, the impact baseline) has no use for rule settings and overrides, so
  // entries for rules it does not load cannot fail it.
  const configured = opts.config ?? defaultConfig();
  return opts.only?.length === 0 ? { ...configured, rules: {}, overrides: [] } : configured;
}

/** The lockfile as read, with the entries fetched for this run added where it has none. */
function withFetched(read: RemotesLockRead, fetched: RemotesLock['remotes'] | undefined): RemotesLockRead {
  if (!fetched || !Object.keys(fetched).length) return read;
  return {
    ...read,
    lock: { ...read.lock, version: 1, remotes: { ...fetched, ...read.lock?.remotes } },
    fetched: Object.keys(fetched),
  };
}

/** Units to load even when nothing here uses them: what the config (and, in impact mode, the baseline) publishes. */
function publishPatternsOf(config: FlowpactConfig, opts: AnalyzeOptions): string[] {
  return [
    ...new Set([
      ...(config.impact.publish ?? []),
      ...(opts.impact?.policy.publish ?? []),
      ...(opts.impact?.publishedFiles ?? []),
    ]),
  ];
}

/** Loads the project's workflows and actions (the targeted ones and what they reach, plus what is published). */
function loadUnits(
  opts: AnalyzeOptions,
  logger: Logger,
  publish: string[],
  repository: string | undefined,
  remotes: RemotesLockRead,
): Project {
  const interfaces = remoteInterfaces(remotes.lock);
  return logger.time('load project', () =>
    loadProject({
      root: opts.root,
      ...(opts.fs ? { fs: opts.fs } : {}),
      ...(opts.paths ? { paths: opts.paths } : {}),
      ...(publish.length ? { publish } : {}),
      ...(repository ? { repository } : {}),
      ...(interfaces.length ? { remotes: interfaces } : {}),
      validateSchema: opts.validateSchema ?? true,
      logger,
    }),
  );
}

/** A job's matrix: as the workflow states it, with the keys the config declares for a dynamic one added. */
function expandJobMatrix(config: FlowpactConfig, unit: UnitDecl, job: JobDecl): MatrixExpansion {
  const shape = config.matrixShapes[`${unit.path}#${job.id}`];
  if (shape && (job.matrix?.dynamic || job.matrix?.includeDynamic)) {
    // Declared keys complement whatever the workflow states statically.
    const staticKeys = expandMatrix(job.matrix).keys;
    return declaredMatrix([...new Set([...staticKeys, ...shape.keys])]);
  }
  return expandMatrix(job.matrix);
}

/**
 * Every job's matrix, expanded once and cached for the rules, with the number of combinations. Every matrix is
 * expanded up front so stats and debug logs are complete even if no rule asks.
 */
function expandMatrices(
  project: Project,
  config: FlowpactConfig,
  logger: Logger,
): { matrix: RuleContext['matrix']; combinations: () => number } {
  const cache = new Map<JobDecl, MatrixExpansion>();
  let combinations = 0;
  const matrix = (unit: UnitDecl, job: JobDecl): MatrixExpansion => {
    let exp = cache.get(job);
    if (!exp) {
      exp = expandJobMatrix(config, unit, job);
      cache.set(job, exp);
      combinations += exp.combos.length;
      logger.debug(`matrix expanded: ${unit.path} › jobs.${job.id}`, {
        combinations: exp.combos.length,
        keys: exp.keys,
        exact: exp.exact,
        dynamic: exp.dynamic,
      });
    }
    return exp;
  };
  for (const wf of project.workflows.values())
    for (const job of Object.values(wf.jobs)) if (job.matrix) matrix(wf, job);
  return { matrix, combinations: () => combinations };
}

/**
 * The effective severity of each rule, and the codes `--only` selects (undefined: every rule). Config entries for
 * rules that are not loaded go to `unloaded`; an unknown rule passed to `--only` is an error.
 */
function selectRules(
  registry: RuleRegistry,
  config: FlowpactConfig,
  only: string[] | undefined,
  unloaded: string[],
): { severities: Map<string, SeveritySetting>; only: string[] | undefined } {
  // Warned about once, with the overrides' entries, after the rules ran.
  const severities = resolveSeverities(registry, config, { unloaded });
  const unknownOnly = (only ?? []).filter((o) => !registry.get(o));
  if (unknownOnly.length) {
    const names = registry.all().flatMap((r) => [r.code, r.name]);
    throw new ConfigError(
      'Unknown rule passed to --only',
      undefined,
      unknownOnly.map((o) => {
        const guess = didYouMean(o, names);
        return `${o}: unknown rule${guess ? ` (did you mean ${guess}?)` : ''}`;
      }),
    );
  }
  return { severities, only: only?.map((o) => registry.get(o)!.code) };
}

/** What paths narrow the report to. */
interface ReportScope {
  /**
   * Whether paths narrow it: any paths but the whole repository, even when they name no workflow or action of the
   * working tree (callers refuse such paths, except in impact mode where they name what the change removed).
   */
  narrowed: boolean;
  /** Whether a contract is in scope (with paths: of a target, or listing one as a consumer). */
  contractInScope: (e: ContractPlanEntry) => boolean;
}

/** Check mode: the contracts on disk compared with the current ones (with paths, only the contracts in scope). */
function compareContracts(
  opts: AnalyzeOptions,
  index: ProjectIndex,
  scope: ReportScope,
  logger: Logger,
): ContractPlan | undefined {
  if (!opts.checkContracts) return undefined;
  let contracts = logger.time('compare contracts', () =>
    planContracts(index, opts.fs ?? nodeFileSystem(opts.root)),
  );
  // With paths, only the contracts in scope count (drift output, patch, summary).
  if (scope.narrowed) contracts = scopePlan(contracts, scope.contractInScope);
  logger.info(
    `contracts: ${contracts.counts.unchanged} unchanged, ${contracts.counts.update} outdated, ${contracts.counts.create} missing, ${contracts.counts.delete} orphaned`,
    { breaking: contracts.breaking },
  );
  return contracts;
}

/** A path relative to the root, with `/` separators. */
const rootRelative = (root: string, path: string) =>
  relative(root, resolve(root, path)).split('\\').join('/') || '.';

/**
 * Impact mode: the paths, as given, that name no workflow or action of the working tree but one of the baseline, or a
 * directory that held one. They name what the change removed, so they are neither missing nor beside the point.
 */
function removedPathsOf(opts: AnalyzeOptions, project: Project): string[] {
  if (!opts.impact) return [];
  const absent = [...(project.missingTargets ?? []), ...(project.ignoredTargets ?? [])];
  const baseFiles = opts.impact.base.units().map((u) => u.file);
  return absent.filter((p) => baseFiles.some((f) => pathHolds(rootRelative(opts.root, p), f)));
}

/** Impact mode's paths: the paths given, unless there are none or one is the whole repository. */
function impactPathsOf(opts: AnalyzeOptions, project: Project): ImpactPaths | undefined {
  if (!opts.impact || !opts.paths?.length || project.wholeRepository) return undefined;
  return {
    paths: opts.paths.map((given) => ({ given, relative: rootRelative(opts.root, given) })),
    targets: project.targets,
  };
}

/**
 * Why impact mode does not run with these paths: nothing published within them when it runs only then (`impact:
 * auto`), or nothing to grade or to report on, i.e. nothing published and no workflow or action of the working tree
 * within them that `ignore` does not leave out: `ignored` when `ignore` left out what is there, else the paths hold
 * only what the change removed.
 */
function pathsSkip(
  scope: ImpactScope,
  narrowed: ImpactNarrowed,
  onlyIfPublished: boolean | undefined,
  ignored: boolean,
): string | undefined {
  if (scope.units.length) return undefined;
  if (onlyIfPublished)
    return narrowed.ignored.length
      ? 'every published workflow or action within the paths is ignored; see ignore'
      : 'no published workflow or action within the paths; see impact.publish';
  if (narrowed.anchor) return undefined;
  return ignored
    ? 'every workflow and action within the paths is ignored: nothing to grade or to report on'
    : 'nothing within the paths to grade or to report on';
}

/**
 * Why impact mode does not run: with paths, see `pathsSkip`; without, `ignore` leaves out every workflow and action, so
 * nothing is graded and there is no file to report on. `targets` counts the workflow and action files the paths name.
 */
function impactSkip(
  impact: ImpactResult,
  onlyIfPublished: boolean | undefined,
  targets: number,
): string | undefined {
  const { scope, narrowed } = impact;
  if (!narrowed) return undefined;
  // Without an anchor, every file the paths name is one that ignore leaves out.
  if (scope) return pathsSkip(scope, narrowed, onlyIfPublished, narrowed.ignored.length > 0 || targets > 0);
  if (impact.publishedFiles.length || narrowed.anchor) return undefined;
  return 'every workflow and action is ignored: nothing to grade or to report on';
}

/**
 * Notes about how impact mode graded: the published units only the pull request's `ignore` matches, graded until it is
 * merged, or, when the baseline's version of a base config (`unread`) cannot be read, graded for that.
 */
function gradingNotes(impact: ImpactResult, unread: string | undefined): string[] {
  if (!impact.ignoreAdded) return [];
  const units = impact.ignoreAdded.join(', ');
  return [
    unread
      ? `the baseline's ignore lacks what the pull request's leaves out of impact mode (${units}), as the baseline's version of ${unread} cannot be read; they are graded`
      : `this pull request changes what ignore leaves out of impact mode (${units}); that applies after it is merged`,
  ];
}

/**
 * What impact mode looks at: the paths, and the units `ignore` leaves out. A unit is left out only when both the
 * baseline's `ignore` and the pull request's own match it: the config's (`head`), and its commits' where they differ.
 */
function lookAtOf(
  opts: AnalyzeOptions,
  within: ImpactPaths | undefined,
  head: readonly string[],
): ImpactLookAt {
  const baseline = opts.impact?.ignore;
  const afterMerge = opts.impact?.ignoreAfterMerge;
  return {
    ...(within ? { within } : {}),
    ...(baseline ? { ignore: { baseline, head, ...(afterMerge ? { afterMerge } : {}) } } : {}),
  };
}

/**
 * Impact mode's changes and verdict, when it runs: about the published units it looks at (with paths, those within
 * them; never one whose file both the baseline's and the pull request's `ignore` match). With nothing to grade or
 * report on, why it does not.
 */
function impactOf(
  opts: AnalyzeOptions,
  index: ProjectIndex,
  lookAt: ImpactLookAt,
  logger: Logger,
): Pick<RuleRun, 'impact' | 'impactSkipped' | 'impactNotes'> {
  const impact = opts.impact;
  if (!impact) return { impact: undefined };
  const result = logger.time('impact', () =>
    computeImpact(impact.base, index, impact.baseline, impact.declared, impact.policy, lookAt),
  );
  const skipped = impactSkip(result, impact.onlyIfPublished, index.project.targets.size);
  // The notes hold whether impact mode runs or not.
  const notes = gradingNotes(result, impact.ignoreUnread);
  return {
    ...(skipped ? { impact: undefined, impactSkipped: skipped } : { impact: result }),
    ...(notes.length ? { impactNotes: notes } : {}),
  };
}

/** What running the rules of one analysis needs. */
interface RuleRun {
  registry: RuleRegistry;
  severities: Map<string, SeveritySetting>;
  /** The codes `--only` selects; undefined for every rule. */
  only: string[] | undefined;
  ruleLog: Logger;
  index: ProjectIndex;
  config: FlowpactConfig;
  matrix: RuleContext['matrix'];
  configFile: string | undefined;
  contracts: ContractPlan | undefined;
  /** The remote interfaces lockfile as read. */
  remotes: RemotesLockRead;
  impact: ImpactResult | undefined;
  /** Why impact mode did not run although it was set up. */
  impactSkipped?: string;
  /** Notes about how impact mode graded, whether it ran or not. */
  impactNotes?: string[];
  /** Generated files, whose internals rules with `generatedFiles: 'skip'` stay quiet about. */
  generatedFiles: Map<string, string>;
  /** Whether a rule runs in this analysis (`ctx.runs`). */
  runs: (code: string) => boolean;
  /** Findings not reported because they are about the internals of generated files. */
  skipped: Finding[];
}

/** A run of these rules, with `runs` answering for it. */
function ruleRun(fields: Omit<RuleRun, 'runs' | 'skipped'>): RuleRun {
  const { registry, severities, only } = fields;
  const runs = (code: string): boolean => {
    const rule = registry.get(code);
    if (!rule) return false;
    return (
      (severities.get(rule.code) ?? rule.defaultSeverity) !== 'off' && (!only || only.includes(rule.code))
    );
  };
  return { ...fields, runs, skipped: [] };
}

/** The context a rule checks in; what it reports goes to `out`, or to the skipped findings for a generated file. */
function ruleContext(
  run: RuleRun,
  rule: RuleDefinition,
  severity: SeveritySetting,
  out: Finding[],
  extra: Partial<RuleContext>,
): RuleContext {
  return {
    index: run.index,
    config: run.config,
    logger: run.ruleLog.child(rule.code),
    matrix: run.matrix,
    runs: run.runs,
    ...(run.configFile ? { configFile: run.configFile } : {}),
    ...(run.contracts ? { contracts: run.contracts } : {}),
    ...(run.impact ? { impact: run.impact } : {}),
    remotes: run.remotes,
    ...extra,
    report: (input) => {
      const finding = toFinding(rule, severity, input, run.registry);
      if (rule.generatedFiles === 'skip' && run.generatedFiles.has(input.loc.file)) run.skipped.push(finding);
      else out.push(finding);
    },
  };
}

/** Runs one rule, logging how many findings it added to `out` and how long it took; a crash is logged and rethrown. */
function checkRule(run: RuleRun, rule: RuleDefinition, ctx: RuleContext, out: Finding[]): void {
  const before = out.length;
  const t0 = performance.now();
  try {
    rule.check(ctx);
  } catch (err) {
    run.ruleLog.error(`${rule.code} ${rule.name} crashed: ${(err as Error).message}`, {
      stack: (err as Error).stack,
    });
    throw err;
  }
  run.ruleLog.debug(`${rule.code} ${rule.name}`, {
    findings: out.length - before,
    ms: Math.round((performance.now() - t0) * 100) / 100,
  });
}

/** Runs the rules of a phase that are on (and selected by `--only`), in registry order. */
function runRules(run: RuleRun, phase: 'main' | 'post', extra: Partial<RuleContext>): Finding[] {
  const out: Finding[] = [];
  for (const rule of run.registry.all()) {
    if ((rule.phase ?? 'main') !== phase) continue;
    const severity = run.severities.get(rule.code) ?? rule.defaultSeverity;
    if (severity === 'off' || (run.only && !run.only.includes(rule.code))) {
      run.ruleLog.trace(`${rule.code} ${rule.name} skipped`, { severity });
      continue;
    }
    checkRule(run, rule, ruleContext(run, rule, severity, out, extra), out);
  }
  return out;
}

/** Whether a rule never runs in this analysis: not loaded, or a rule of a mode (impact, check) that is not on. */
function notRunIn(rule: RuleDefinition | undefined, opts: AnalyzeOptions): boolean {
  // Contract rules only run in check mode; under `lint` their overrides cannot be judged. Rules of skipped plugins
  // never run at all.
  if (!rule) return true;
  return IMPACT_CODES.includes(rule.code)
    ? !opts.impact
    : rule.category === 'contracts' && !opts.checkContracts;
}

/** Counts the findings skipped in generated files that an override would match (FP902 says why it matches nothing). */
function countSkipped(u: OverrideUsage, code: string, skipped: Finding[]): void {
  const n = skipped.filter((f) => overrideMatches(u.override, code, f)).length;
  if (n) u.skippedInGenerated = n;
}

/**
 * Marks an override whose rule does not run in this analysis as inactive, and counts the findings it would match that
 * are skipped in generated files.
 */
function judgeOverride(u: OverrideUsage, run: RuleRun, opts: AnalyzeOptions): void {
  const code = run.registry.get(u.override.rule)?.code ?? '';
  const severity = run.severities.get(code);
  const rule = run.registry.get(code);
  const notRun = notRunIn(rule, opts);
  if (severity === 'off' || (run.only && !run.only.includes(code)) || notRun) u.inactive = true;
  // An override written for findings that are now skipped in generated files.
  if (!u.matched && rule) countSkipped(u, rule.code, run.skipped);
}

/**
 * Whether a finding is reported: impact mode's always (it grades only the published units within the paths that
 * `ignore` does not leave out, so its findings and its verdict agree); any other with paths when it is about a targeted
 * file or a contract in scope, and when no `ignore` pattern matches its file.
 */
function scopeOf(
  index: ProjectIndex,
  config: FlowpactConfig,
  contracts: ContractPlan | undefined,
  scope: ReportScope,
): (f: Finding) => boolean {
  const { targets } = index.project;
  // The contract of a targeted workflow belongs to it (e.g. a conflicted contract, FP805), and so do the contracts
  // that list it as a consumer.
  const scopedEntries = (contracts?.entries ?? []).filter(scope.contractInScope);
  const contractFilesInScope = new Set(scopedEntries.map((e) => e.file));
  // Contract findings are reported on the workflow they describe; they follow their contract into scope.
  const contractUnitsInScope = new Set(
    scopedEntries.flatMap((e) => (e.unit ? [index.unit(e.unit)?.file ?? e.unit] : [])),
  );
  return (f) =>
    IMPACT_CODES.includes(f.code) ||
    ((!scope.narrowed ||
      targets.has(f.loc.file) ||
      contractFilesInScope.has(f.loc.file) ||
      (f.category === 'contracts' && contractUnitsInScope.has(f.loc.file))) &&
      !config.ignore.some((p) => matchesPattern(f.loc.file, p)));
}

/** Logs what the scope, generated files and overrides took out of the findings. */
function logFiltered(
  logger: Logger,
  config: FlowpactConfig,
  f: {
    findings: Finding[];
    accepted: Finding[];
    suppressed: SuppressedFinding[];
    skippedInScope: Finding[];
    usage: OverrideUsage[];
  },
): void {
  if (f.skippedInScope.length > 0) {
    logger.info(
      `skipped ${f.skippedInScope.length} finding(s) about the internals of ${new Set(f.skippedInScope.map((s) => s.loc.file)).size} generated file(s)`,
    );
  }
  if (f.accepted.length + f.suppressed.length !== f.findings.length) {
    logger.debug(
      `filtered ${f.findings.length - f.accepted.length - f.suppressed.length} finding(s) by targets/ignore`,
    );
  }
  if (config.overrides.length) {
    logger.info(
      `overrides: ${f.suppressed.length} finding(s) suppressed by ${f.usage.filter((u) => u.matched && !u.expired).length} override(s)`,
      {
        expired: f.usage.filter((u) => u.expired).length,
        unused: f.usage.filter((u) => !u.matched && !u.expired && !u.inactive).length,
      },
    );
  }
}

/** Report order: by location, then severity, then code. */
const byReportOrder = (a: Finding, b: Finding): number =>
  compareLoc(a.loc, b.loc) ||
  SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
  a.code.localeCompare(b.code);

/** The result's metadata: the tool, the root, the config file and the repository. */
function metaOf(opts: AnalyzeOptions, repository: string | undefined): AnalysisResult['meta'] {
  return {
    ...toolMeta(),
    root: opts.root,
    ...(opts.configFile ? { configFile: opts.configFile } : {}),
    ...(repository ? { repository } : {}),
  };
}

/** Impact mode's part of the result: its verdict or why it was skipped, notes on how it graded, the removed paths. */
function impactFieldsOf(
  run: RuleRun,
  removedPaths: string[] | undefined,
): Pick<AnalysisResult, 'impact' | 'impactSkipped' | 'impactNotes' | 'removedPaths'> {
  return {
    ...(run.impact ? { impact: run.impact } : {}),
    ...(run.impactSkipped ? { impactSkipped: run.impactSkipped } : {}),
    ...(run.impactNotes ? { impactNotes: run.impactNotes } : {}),
    ...(removedPaths?.length ? { removedPaths } : {}),
  };
}

/** The analysis result, from what the run produced. */
function resultOf(
  opts: AnalyzeOptions,
  run: RuleRun,
  r: Pick<
    AnalysisResult,
    'project' | 'findings' | 'summary' | 'suppressed' | 'durationMs' | 'removedPaths'
  > & {
    repository: string | undefined;
    unloaded: string[];
  },
): AnalysisResult {
  return {
    meta: metaOf(opts, r.repository),
    project: r.project,
    index: run.index,
    findings: r.findings,
    summary: r.summary,
    rules: run.registry.all().map((x) => ({
      code: x.code,
      name: x.name,
      severity: run.severities.get(x.code) ?? x.defaultSeverity,
    })),
    suppressed: r.suppressed,
    ...(run.contracts ? { contracts: run.contracts } : {}),
    ...(r.unloaded.length ? { unloadedRules: r.unloaded } : {}),
    ...impactFieldsOf(run, r.removedPaths),
    ...(opts.configFile && opts.configText !== undefined
      ? { configSource: new SourceFile(opts.configFile, opts.configText) }
      : {}),
    durationMs: r.durationMs,
  };
}

/** Everything the rules of an analysis run with; config entries for rules that are not loaded go to `unloaded`. */
function prepareRules(
  opts: AnalyzeOptions,
  logger: Logger,
  base: Pick<RuleRun, 'registry' | 'index' | 'config' | 'matrix' | 'remotes'>,
  unloaded: string[],
): { run: RuleRun; scope: ReportScope } {
  const { registry, index, config } = base;
  const { severities, only } = selectRules(registry, config, opts.only, unloaded);
  const ruleLog = logger.child('rules');
  // Generated files (gh-aw lock files, `DO NOT EDIT` headers) are checked as callers and callees, but rules about their
  // internals (`generatedFiles: 'skip'`) stay quiet: nobody can act on them in the file itself.
  const generatedFiles = generatedFilesOf(index.project, config);
  for (const [file, marker] of generatedFiles) logger.debug(`generated file: ${file}`, { marker });
  const within = impactPathsOf(opts, index.project);
  const scope: ReportScope = {
    narrowed: Boolean(opts.paths?.length) && !index.project.wholeRepository,
    contractInScope: contractsInScope(index, { root: opts.root, paths: opts.paths ?? [] }),
  };
  const contracts = compareContracts(opts, index, scope, logger);
  const impact = impactOf(opts, index, lookAtOf(opts, within, config.ignore), logger);
  if (impact.impactSkipped) logger.debug(`impact: skipped (${impact.impactSkipped})`);
  const run = ruleRun({
    ...base,
    severities,
    only,
    ruleLog,
    configFile: opts.configFile,
    contracts,
    ...impact,
    generatedFiles,
  });
  return { run, scope };
}

/**
 * Runs the main rules, applies the overrides and the scope, then runs the post rules: the findings to report, the
 * ones overrides accepted, and the ones in scope skipped in generated files.
 */
function runPhases(
  run: RuleRun,
  opts: AnalyzeOptions,
  logger: Logger,
  scope: ReportScope,
  unloaded: string[],
): { kept: Finding[]; suppressed: SuppressedFinding[]; skippedInScope: Finding[] } {
  const { config } = run;
  const findings = dedupe(runRules(run, 'main', {}));
  // Overrides are matched against the whole repository, so linting a subset of files does not make
  // overrides for other files look unused; the scope filter is applied afterwards.
  const applied = applyOverrides(
    findings,
    config,
    run.registry,
    opts.overrideLocs ?? [],
    opts.now ?? new Date(),
    { unloaded },
  );
  if (unloaded.length)
    logger.warn(`ignoring config entries for rules that are not loaded: ${unloaded.join('; ')}`);
  for (const u of applied.usage) judgeOverride(u, run, opts);
  const inScope = scopeOf(run.index, config, run.contracts, scope);
  const accepted = applied.kept.filter(inScope);
  const suppressed = applied.suppressed.filter(inScope);
  const skippedInScope = dedupe(run.skipped).filter(inScope);
  logFiltered(logger, config, { findings, accepted, suppressed, skippedInScope, usage: applied.usage });
  const post = runRules(run, 'post', { overrides: applied.usage });
  return { kept: dedupe([...accepted, ...post]).sort(byReportOrder), suppressed, skippedInScope };
}

export function analyze(opts: AnalyzeOptions): AnalysisResult {
  const started = performance.now();
  const logger = opts.logger ?? silentLogger;
  const config = effectiveConfig(opts);
  const publishPatterns = publishPatternsOf(config, opts);
  const registry = opts.registry ?? createRegistry();
  const repository = opts.repository ?? config.repository ?? detectRepository(opts.root);
  logger.debug('config resolved', {
    file: opts.configFile ?? '(defaults)',
    repository: repository ?? '(unknown)',
    rules: Object.keys(config.rules).length,
  });

  const remotes = withFetched(readRemotesLock(opts.fs ?? nodeFileSystem(opts.root)), opts.fetchedRemotes);
  const project = loadUnits(opts, logger, publishPatterns, repository, remotes);
  const index = logger.time('build graph', () => new ProjectIndex(project));
  logger.info(
    `graph built: ${index.nodes.size} symbols, ${index.edges.length} edges, ${index.callSites.length} reusable calls`,
  );
  const { matrix, combinations } = expandMatrices(project, config, logger);

  const unloaded: string[] = [];
  const { run, scope } = prepareRules(opts, logger, { registry, index, config, matrix, remotes }, unloaded);
  const { kept, suppressed, skippedInScope } = runPhases(run, opts, logger, scope, unloaded);

  const summary = summarize(project, index, kept, combinations(), suppressed.length, skippedInScope.length);
  const durationMs = Math.round(performance.now() - started);
  logger.info(
    `analysis finished: ${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.infos} info`,
    { ms: durationMs },
  );
  return resultOf(opts, run, {
    repository,
    project,
    findings: kept,
    summary,
    suppressed,
    unloaded,
    durationMs,
    removedPaths: removedPathsOf(opts, project),
  });
}

function toFinding(
  rule: RuleDefinition,
  severity: SeveritySetting,
  input: ReportInput,
  registry: RuleRegistry,
): Finding {
  // A finding may ask for a milder severity than its rule's, never a stronger one (plugins pass any value here).
  const requested = input.severity;
  const effective =
    requested !== undefined &&
    Object.hasOwn(SEVERITY_ORDER, requested) &&
    SEVERITY_ORDER[requested] > SEVERITY_ORDER[severity as Severity]
      ? requested
      : (severity as Severity);
  return {
    code: rule.code,
    name: rule.name,
    severity: effective,
    category: rule.category,
    message: escapeControl(input.message),
    loc: input.loc,
    related: (input.related ?? []).map((r) => ({ ...r, message: escapeControl(r.message) })),
    ...(input.combos?.length ? { combos: input.combos.map((c) => escapeControl(c)) } : {}),
    ...(input.symbol ? { symbol: escapeControl(input.symbol) } : {}),
    why: rule.docs.why,
    // Per-finding fixes embed names from the YAML, so newlines are escaped unless the rule vouches for the text.
    fix:
      input.fix !== undefined
        ? escapeControl(input.fix, input.fixMultiline === true)
        : escapeControl(rule.docs.fix, true),
    docsUrl: registry.docsUrl(rule),
    fingerprint: fingerprint(rule.code, input.symbol, input.loc.file, input.message),
  };
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.code}|${f.loc.file}:${f.loc.line}:${f.loc.column}|${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarize(
  project: Project,
  index: ProjectIndex,
  findings: Finding[],
  combinations: number,
  suppressed: number,
  skippedInGenerated: number,
): Summary {
  const byCode: Record<string, number> = {};
  const byFile: Record<string, number> = {};
  for (const f of findings) {
    byCode[f.code] = (byCode[f.code] ?? 0) + 1;
    byFile[f.loc.file] = (byFile[f.loc.file] ?? 0) + 1;
  }
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    infos: findings.filter((f) => f.severity === 'info').length,
    total: findings.length,
    workflows: project.workflows.size,
    actions: project.actions.size,
    jobs: [...project.workflows.values()].reduce((n, wf) => n + Object.keys(wf.jobs).length, 0),
    matrixCombinations: combinations,
    graph: { nodes: index.nodes.size, edges: index.edges.length },
    byCode,
    byFile,
    suppressed,
    skippedInGenerated,
  };
}

/**
 * Generated workflow and action files, with the reason: the marker `generatedMarker` found, or the config. Files in
 * `generated.exclude` are never generated; files in `generated.include` always are.
 */
function generatedFilesOf(project: Project, config: FlowpactConfig): Map<string, string> {
  const out = new Map<string, string>();
  const listed = (u: UnitDecl, patterns: string[]) =>
    patterns.some((p) => matchesPattern(u.file, p) || matchesPattern(u.path, p));
  for (const u of [...project.workflows.values(), ...project.actions.values()]) {
    if (listed(u, config.generated.exclude)) continue;
    if (u.generated) out.set(u.file, u.generated);
    else if (listed(u, config.generated.include)) out.set(u.file, 'generated.include');
  }
  return out;
}

const DAY = 86_400_000;

/** Glob for symbols and paths: `**` matches anything, `*` anything except `/`. Exact match otherwise. */
export function matchesTarget(value: string, pattern: string): boolean {
  if (!pattern.includes('*')) return value === pattern;
  const re = new RegExp(
    `^${pattern
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*'),
      )
      .join('.*')}$`,
  );
  return re.test(value);
}

export function overrideMatches(o: Override, code: string, f: Finding): boolean {
  if (code !== f.code) return false;
  if (o.target !== undefined && (f.symbol === undefined || !matchesTarget(f.symbol, o.target))) return false;
  if (o.file !== undefined && !matchesPattern(f.loc.file, o.file) && !matchesTarget(f.loc.file, o.file))
    return false;
  return true;
}

/** Splits findings into kept and suppressed, and records how each override was used. */
export function applyOverrides(
  findings: Finding[],
  config: FlowpactConfig,
  registry: RuleRegistry,
  locs: Loc[],
  now: Date,
  opts: { unloaded?: string[] } = {},
): { kept: Finding[]; suppressed: SuppressedFinding[]; usage: OverrideUsage[] } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const unknown = { hard: [] as string[], tolerated: [] as string[] };
  const usage: (OverrideUsage & { code: string })[] = config.overrides.map((override, index) => {
    const rule = registry.get(override.rule);
    if (!rule) triageUnknown(registry, override.rule, `overrides.${index}.rule`, unknown);
    const daysLeft = override.expires
      ? Math.round((Date.parse(`${override.expires}T00:00:00Z`) - today) / DAY)
      : undefined;
    return {
      index,
      override,
      code: rule?.code ?? '',
      ...(locs[index] ? { loc: locs[index] } : {}),
      matched: 0,
      expired: daysLeft !== undefined && daysLeft < 0,
      ...(daysLeft !== undefined ? { daysLeft } : {}),
    };
  });
  if (unknown.hard.length)
    throw new ConfigError('Config overrides reference unknown rules', undefined, unknown.hard);
  opts.unloaded?.push(...unknown.tolerated);
  const kept: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const f of findings) {
    const matching = usage.filter((u) => overrideMatches(u.override, u.code, f));
    for (const u of matching) u.matched++;
    const active = matching.find((u) => !u.expired);
    if (!active) {
      kept.push(f);
      continue;
    }
    const o = active.override;
    suppressed.push({
      ...f,
      override: {
        index: active.index,
        reason: o.reason,
        ...(o.expires ? { expires: o.expires } : {}),
        ...(o.owner ? { owner: o.owner } : {}),
      },
    });
  }
  return { kept, suppressed, usage: usage.map(({ code: _code, ...u }) => u) };
}

/** Exit code policy shared by the CLI and the action. */
export function exitCodeFor(
  summary: Pick<Summary, 'errors' | 'warnings'>,
  failOn: 'error' | 'warning' | 'never',
): number {
  if (failOn === 'never') return 0;
  if (summary.errors > 0) return 1;
  if (failOn === 'warning' && summary.warnings > 0) return 1;
  return 0;
}
