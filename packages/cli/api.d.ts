/**
 * flowpact's programmatic API: one function per CLI command, for programs that run flowpact themselves, such as an
 * organization's own JavaScript action. https://ciatlas.github.io/flowpact/docs/api
 *
 * - Options are the command's flags in camelCase. Relative paths are read from the working directory, like the CLI's;
 *   `paths` are relative to `root`.
 * - Nothing is printed and the process never exits: results are returned, and expected failures are thrown as a
 *   {@link FlowpactError}.
 * - Before 1.0, a minor release can change this API in an incompatible way, as it can the CLI; its release notes say
 *   so. `RuleContext.index` and the types it leads to are not covered: see {@link RuleContext}.
 */

/** The flowpact version, e.g. `0.9.0`. */
export declare const VERSION: string;

// ---------------------------------------------------------------------------------------------------------------------
// Options

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface LogRecord {
  level: Exclude<LogLevel, 'silent'>;
  /** `flowpact`, or a part of it such as `flowpact:rules`. */
  scope: string;
  message: string;
  data?: Record<string, unknown>;
  /** Milliseconds since the epoch. */
  time: number;
}

/** Where log records go. Without `log`, nothing is logged. */
export interface LogOptions {
  /** The most detailed level to write. Default: `info`. */
  level?: LogLevel;
  write(record: LogRecord): void;
}

/** Options of every function. */
export interface CommonOptions {
  /** Repository root (`--root`). Default: the working directory. */
  root?: string;
  /** Config file (`--config`). Default: `.github/flowpact/flowpact.config.yml` under the root, when it exists. */
  config?: string;
  /** Defaults under the repository's config, such as an organization's (`--base-config`). */
  baseConfig?: string;
  log?: LogOptions;
}

/** Options of the functions that load rules. */
export interface PluginOptions {
  /** Plugins to load besides those the config lists (`--plugin`); not affected by `repositoryPlugins`. */
  plugins?: string[];
  /**
   * Load the plugins the repository's config lists, which runs the repository's code. Default: true; false is
   * `--no-plugins`, for code you do not trust (such as a pull request from a fork).
   */
  repositoryPlugins?: boolean;
}

export type ImpactLevel = 'none' | 'patch' | 'minor' | 'major';

/**
 * The options of impact mode. In GitHub Actions (`GITHUB_ACTIONS=true`), the pull request's base, title and labels are
 * read from the event, as the CLI does. The baseline commit must be in the clone (check out with `fetch-depth: 0`).
 */
export interface ImpactModeOptions {
  /** Baseline ref (`--base`). Default: the pull request's base in GitHub Actions, else `origin/HEAD`. */
  base?: string;
  /** The declared impact (`--expect`). Default: read from `title`, `labels` or the pull request. */
  expect?: ImpactLevel;
  /** Pull request title to read the declared impact from (Conventional Commits). */
  title?: string;
  /** Pull request labels (`semver:major`, `semver:minor`, …). */
  labels?: string[];
}

export interface LintOptions extends CommonOptions, PluginOptions, ImpactModeOptions {
  /**
   * Workflow and action files or directories to report on, relative to the root. Default: all. With `impact`, impact
   * mode grades only the published workflows and actions within them.
   */
  paths?: string[];
  /** Run only these rules (codes or names). */
  only?: string[];
  /** Validate against GitHub's workflow schema. Default: true. */
  schema?: boolean;
  /** Also check the release impact of changes to published workflows and actions (`--impact`). */
  impact?: boolean;
  /** The current time, for the expiry of overrides (the CLI reads `FLOWPACT_NOW`). Default: now. */
  now?: Date;
}

export interface CheckOptions extends LintOptions {}

export interface ImpactOptions extends CommonOptions, PluginOptions, ImpactModeOptions {
  /**
   * Workflow and action files or directories, relative to the root: grade only the published ones within them, so the
   * verdict is about those alone. A path the change removed counts when the baseline has a workflow or action there.
   * Default: every published workflow and action.
   */
  paths?: string[];
  /** Run only these rules. Default: the impact rules. */
  only?: string[];
  /** The current time, for the expiry of overrides. Default: now. */
  now?: Date;
}

export interface GenerateOptions extends CommonOptions, PluginOptions {
  /** Workflows and actions whose contracts to write, relative to the root; contracts listing them as a consumer too. */
  paths?: string[];
  /** Compute the changes without writing anything (`--dry-run`; for `--patch`, write `patch()` yourself). */
  dryRun?: boolean;
  /** Write all contracts under this directory instead of the repository. */
  out?: string;
}

export interface GraphOptions extends CommonOptions {
  /** Workflow and action files or directories, relative to the root: only them and what they call and use. Default: all. */
  paths?: string[];
}

export interface TraceOptions extends CommonOptions, PluginOptions {
  /** e.g. `pipeline.yml#inputs.config`, `pipeline.yml:config`, or `pipeline.yml` for its whole interface. */
  symbol: string;
  /** Trace upstream: who provides the value (`--up`). */
  up?: boolean;
  /** Maximum depth. Default: 12. */
  depth?: number;
}

export interface RulesOptions extends CommonOptions, PluginOptions {}

export interface ExplainOptions extends CommonOptions, PluginOptions {}

// ---------------------------------------------------------------------------------------------------------------------
// The JSON report (https://ciatlas.github.io/flowpact/schemas/report/v1.json)

export type Severity = 'error' | 'warning' | 'info';
export type SeveritySetting = Severity | 'off';

/** A 1-based range in a file; `file` is relative to the root, with `/` separators. */
export interface Loc {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface Finding {
  code: string;
  name: string;
  severity: Severity;
  category: string;
  message: string;
  loc: Loc;
  /** Supporting locations; for a problem across workflows, the call chain, outermost first. */
  related: { loc: Loc; message: string }[];
  /** The matrix combinations affected, as labels. */
  combos?: string[];
  /** The symbol the finding is about: the `target` of an override. */
  symbol?: string;
  why: string;
  fix: string;
  docsUrl: string;
  /** Stays the same across unrelated edits. */
  fingerprint: string;
}

/** A finding an override accepted. */
export interface SuppressedFinding extends Finding {
  override: { index: number; reason: string; expires?: string; owner?: string };
}

export type ContractStatus = 'create' | 'update' | 'delete' | 'unchanged';

export interface ContractChange {
  breaking: boolean;
  /** e.g. `inputs.config`, `outputs.url`. */
  path: string;
  message: string;
}

export interface ContractEntry {
  /** The contract file, relative to the root. */
  file: string;
  status: ContractStatus;
  /** The workflow or action it describes (absent for an orphaned contract). */
  unit?: string;
  /** Set when the existing file could not be read as a contract. */
  invalid?: string;
  changes: ContractChange[];
}

/** Impact mode's verdict. */
export interface ImpactVerdict {
  baseline: { kind: 'ref' | 'release'; ref: string; commit: string };
  /** The impact the changes require. */
  required: ImpactLevel;
  /** The impact the pull request declares, and where it was read. */
  declared?: { kind: 'explicit' | 'title' | 'labels' | 'version'; value: string; level: ImpactLevel };
  /** The declared impact covers the required one. */
  ok: boolean;
  changes: {
    unit: string;
    kind: string;
    level: ImpactLevel;
    /** False when the change involves something flowpact cannot evaluate. */
    certain: boolean;
    message: string;
    loc: Loc;
  }[];
  /**
   * Only when paths were given: impact mode graded only the published units within them, and the verdict is about
   * those alone.
   */
  scope?: {
    /** The paths given, relative to the root. */
    paths: string[];
    /** The published workflows and actions within them, in the baseline or the working tree: the only ones graded. */
    units: string[];
  };
}

/** The JSON report, schema v1: what `flowpact lint --format json` prints. */
export interface Report {
  $schema: string;
  meta: {
    tool: string;
    version: string;
    schemas: { config: number; contract: number; report: number };
    node: string;
    platform: string;
    root: string;
    configFile?: string;
    repository?: string;
    durationMs: number;
  };
  summary: {
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
    suppressed: number;
    /** Findings not reported because they are about the internals of generated files. */
    skippedInGenerated?: number;
  };
  findings: Finding[];
  suppressed: SuppressedFinding[];
  /** `check` only. */
  contracts?: {
    drift: boolean;
    breaking: number;
    counts: { create: number; update: number; delete: number; unchanged: number };
    entries: ContractEntry[];
  };
  /** Impact mode only. */
  impact?: ImpactVerdict;
  rules: { code: string; name: string; severity: SeveritySetting }[];
  /** With `json({ includeGraph: true })` only. */
  graph?: {
    nodes: { id: string; kind: string; label: string; unit?: string; loc?: Loc }[];
    edges: { from: string; to: string; kind: string; loc?: Loc; siteId?: number }[];
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Results

/**
 * A finding as a GitHub annotation: what `--format github` prints, for `@actions/core`'s `error()`, `warning()` and
 * `notice()`.
 */
export interface Annotation {
  level: 'error' | 'warning' | 'notice';
  message: string;
  title: string;
  file: string;
  startLine: number;
  endLine: number;
  /** Only on annotations of one line: GitHub ignores columns on others. */
  startColumn?: number;
  endColumn?: number;
}

export interface PathPrefixOptions {
  /**
   * The root relative to the repository, when it is a subdirectory of it: GitHub resolves annotation and SARIF paths
   * against the repository, flowpact reports them relative to the root.
   */
  pathPrefix?: string;
}

export interface MarkdownOptions {
  /** Heading of the report. Default: `flowpact report`. */
  title?: string;
  /** Findings listed in full before the rest is summarized, so the report fits a job summary. Default: 50. */
  maxFindings?: number;
  /** e.g. `https://github.com/acme/repo`; with `sha`, locations link to the file at that commit. */
  repoUrl?: string;
  sha?: string;
  /** Add the call graph as a Mermaid diagram. */
  includeGraph?: boolean;
  /** The workflow artifact holding regenerated contracts, for download instructions when contracts drifted. */
  artifact?: { name: string; runId?: string; patchFile?: string };
}

/** How terminal text is rendered: what the CLI decides from `--no-color`, `--ascii` and the terminal. */
export interface TextOptions {
  /** ANSI colors. Default: false. */
  color?: boolean;
  /** Columns to wrap at. Default: 100. */
  width?: number;
  /** ASCII instead of box-drawing characters and symbols. */
  ascii?: boolean;
  /** OSC 8 hyperlinks for docs links, for terminals that support them. */
  hyperlinks?: boolean;
}

/** The terminal report (`--format pretty`). */
export interface PrettyOptions extends TextOptions {
  /** Do not list info-level findings (still counted). */
  hideInfo?: boolean;
}

export type FailOn = 'error' | 'warning' | 'never';

/** What `lint`, `check` and `impact` found, and every report the CLI renders from it. */
export interface Analysis {
  /** The JSON report: what `--format json` prints, parsed. */
  readonly report: Report;
  /** What the CLI prints as `impact: …` lines: impact mode skipped, or notes about its baseline. */
  readonly notes: string[];
  /** `check` only: the comparison with the locked contracts. */
  readonly contracts?: {
    drift: boolean;
    breaking: number;
    /** The regenerated contracts as a patch for `git apply` (`--patch`), or undefined without drift. */
    patch(): string | undefined;
  };
  /** Impact mode's verdict, as in the report, when it ran. */
  readonly impact?: ImpactVerdict;
  /** The CLI's exit code for `--fail-on` (default `error`): 1 when there are findings at that level. */
  exitCode(failOn?: FailOn): 0 | 1;
  annotations(options?: PathPrefixOptions): Annotation[];
  /**
   * The annotations as GitHub workflow commands, one line each (`--format github`): printed in a GitHub Actions step,
   * they annotate the run and the pull request. Every value in them is escaped.
   */
  github(options?: PathPrefixOptions): string;
  /** SARIF 2.1.0, for code scanning. */
  sarif(options?: PathPrefixOptions): string;
  /** The Markdown report, for job summaries and pull request comments. */
  markdown(options?: MarkdownOptions): string;
  /** The JSON report as `--format json` prints it; `includeGraph` adds the data-flow graph. */
  json(options?: { includeGraph?: boolean }): string;
  /** The terminal report (`--format pretty`). */
  pretty(options?: PrettyOptions): string;
}

/** What `generate` wrote, or with `dryRun` would write. */
export interface ContractGeneration {
  /** Whether any contract file is created, changed or removed. */
  drift: boolean;
  /** Breaking changes among them. */
  breaking: number;
  counts: { create: number; update: number; delete: number; unchanged: number };
  entries: ContractEntry[];
  /** Workflows and actions whose contracts were kept because their files have YAML syntax errors. */
  skipped: string[];
  /** Nothing was written: the `dryRun` option. */
  dryRun: boolean;
  /** The files written or removed, relative to the root (or to `out`); empty with `dryRun`. */
  written: string[];
  /** The changes as a patch for `git apply`, or undefined when nothing changes. */
  patch(): string | undefined;
}

export type CallGraphNodeKind = 'workflow' | 'action' | 'remote' | 'missing' | 'invalid';

/**
 * Which workflow calls which reusable workflow, and which local action each job or action uses: what
 * `graph --format json` prints.
 */
export interface CallGraph {
  nodes: {
    /** The workflow or action path, `remote:<uses>` for a remote workflow, the target path when missing or invalid. */
    id: string;
    kind: CallGraphNodeKind;
    label: string;
    /** The events that trigger a workflow. */
    triggers?: string[];
  }[];
  edges: {
    from: string;
    to: string;
    /** Where the call is made: `jobs.<id>`, `jobs.<id> › steps[<n>]` or `steps[<n>]`. */
    via: string;
    kind: 'calls' | 'uses';
    /** Matrix combinations of the calling job, when its matrix is static. */
    matrix?: number;
    /** The call passes every secret with `secrets: inherit`. */
    inherits?: boolean;
    /** The called workflow has no `on.workflow_call`. */
    notReusable?: boolean;
  }[];
  /**
   * With `paths`: the workflows and actions they name, where the graph starts. The tree starts from them even when
   * something in the graph calls them, as in a cycle.
   */
  roots?: string[];
}

export type SymbolKind =
  | 'workflow'
  | 'action'
  | 'remote'
  | 'job'
  | 'input'
  | 'secret'
  | 'output'
  | 'job-output'
  | 'step-output'
  | 'env'
  | 'matrix'
  | 'var'
  | 'unresolved';

export interface TraceNode {
  /** e.g. `.github/workflows/ci.yml#inputs.config`. */
  symbol: string;
  label: string;
  kind: SymbolKind;
  unit?: string;
  loc?: Loc;
  /**
   * How the value got here from the parent node: the expression (`text`) at `loc`, or `workflow output` or
   * `secrets: inherit`. `note` qualifies it:
   * - `when dispatched`: upstream, a workflow input read through `github.event.inputs` in a workflow that can also be
   *   called. The input holds the value only when the workflow is dispatched (a called workflow gets its caller's
   *   event), so it is not traced further up; a `context` leaf stands for the called case;
   * - `the default of inputs.<name>`: upstream, an input or variable that the default of `inputs.<name>` reads;
   * - `exposed to the caller`: downstream, an output of a reusable workflow or action that becomes the output of the
   *   job or step that uses it;
   * - `jobs.<id>`: the job whose `secrets: inherit` passes the secret on.
   */
  via?: { loc: Loc; text: string; note?: string };
  /**
   * Downstream, the symbols the value flows to; upstream, the symbols it is computed from. A whole or computed read
   * (`toJSON(inputs)`, `matrix[inputs.key]`, `secrets[inputs.name]`, `toJSON(env)`) reads every member the files
   * declare: one child each.
   */
  children: TraceNode[];
  /**
   * Downstream, where the value is used, e.g. `run script` or `condition`. Upstream, where it comes from when that is
   * not another symbol: `literal` (a plain value: passed by a caller or a step, an env variable's or output's own
   * value, or an input's default), `omitted` (a caller or step does not pass the input), `value`, `missing` or
   * `dynamic` (a matrix key's combinations), `context` (read from a context flowpact does not follow, such as
   * `github.event.pull_request.title`; `github.event.inputs.<name>` in a workflow that can be called, which then holds
   * the caller's event; or a whole object that may hold members the files do not declare, such as `toJSON(secrets)`,
   * `toJSON(env)` or an action's `toJSON(inputs)`, next to the members it reads; `text` is the reference as written),
   * `invalid` (an expression that does not parse, or, in an input's default, a reference to a context or a call to a
   * function GitHub does not allow there; `text` is then the reference, or the function's name and `()`) or
   * `expression` (an expression that reads no context). When a caller or step omits an input whose default GitHub uses
   * (not a required `workflow_call` input's), the trace also ends at the default, after the callers, with `where`
   * ending in `inputs.<name>.default`. A `workflow_call` default's reads of the workflow's own `workflow_call` inputs
   * (by name, or every one of them through a whole `inputs` such as `toJSON(inputs)`) and of `vars` by name are
   * `children` with `via.note` `the default of inputs.<name>`. Its other references are `context` leaves: an input
   * only `workflow_dispatch` declares, or none does (empty when the workflow is called), a whole or computed `vars`
   * (`vars.*`, `toJSON(vars)`), and `github` (the caller's, including `github.event.inputs`). An action default's
   * `github`, `strategy`, `matrix`, `job` and `runner` are `context` leaves, and a default that only calls
   * `hashFiles()` is an `expression` leaf. Any other context in a default, a status function, or `hashFiles()` in a
   * `workflow_call` default is `invalid`.
   */
  leaves: { role: string; where: string; loc: Loc; text: string }[];
  /** Why the branch stops early; `seen`: it is shown elsewhere in the same trace. */
  stop?: 'cycle' | 'depth' | 'seen';
}

/**
 * `trace --format json`: one tree per matching symbol; none for a workflow or action without inputs, secrets or
 * outputs.
 */
export interface TraceResult {
  query: string;
  direction: 'down' | 'up';
  traces: TraceNode[];
  /** The workflow or action the query names, when it declares no inputs, secrets or outputs (`traces` is empty). */
  unit?: string;
}

export type RuleCategory =
  | 'inputs'
  | 'secrets'
  | 'outputs'
  | 'matrix'
  | 'expressions'
  | 'structure'
  | 'hygiene'
  | 'contracts'
  | 'config';

/** A rule as `rules --format json` lists it. */
export interface RuleInfo {
  code: string;
  name: string;
  category: RuleCategory;
  defaultSeverity: SeveritySetting;
  /** The severity after the config. */
  severity: SeveritySetting;
  summary: string;
  docsUrl: string;
}

/** A rule's documentation, as `explain` shows it. */
export interface RuleDocs extends RuleInfo {
  why: string;
  fix: string;
  /** What the rule deliberately leaves out. */
  scope?: string;
  examples?: { bad: string; good: string };
  /** `skip`: the rule's findings in generated files are not reported. */
  generatedFiles: 'report' | 'skip';
}

/**
 * - `usage`: an option or path that cannot work, such as a path that does not exist or a root without workflows;
 * - `config`: the config or base config is invalid, or names a rule that does not exist;
 * - `plugin`: a plugin is missing, fails to load, exports no rules or registers an invalid rule;
 * - `unsafe-path`: a write through a symlink, or out of the repository, was refused;
 * - `impact-setup`: impact mode has no baseline or cannot read it.
 */
export type FlowpactErrorKind = 'usage' | 'config' | 'plugin' | 'unsafe-path' | 'impact-setup';

/**
 * An expected failure: what the CLI reports with exit code 2. Other errors are bugs, or a plugin rule that threw. The
 * message is written for people (it can name the CLI's flags); act on `kind`.
 */
export declare class FlowpactError extends Error {
  constructor(
    kind: FlowpactErrorKind,
    message: string,
    options?: { file?: string | undefined; issues?: string[]; cause?: unknown },
  );
  readonly kind: FlowpactErrorKind;
  /** The config file the error is about, when there is one. */
  readonly file?: string;
  /** The individual problems, such as one per invalid config entry; can be empty. */
  readonly issues: string[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands

/** `flowpact lint`: analyzes workflows and local actions. */
export declare function lint(options?: LintOptions): Promise<Analysis>;

/** `flowpact check`: lint, and compare with the locked contracts in `.github/flowpact/`. */
export declare function check(options?: CheckOptions): Promise<Analysis>;

/**
 * `flowpact impact`: checks that the declared release impact covers the changes to published workflows and actions.
 * When impact mode is skipped (on `merge_group`, or with paths that hold nothing to grade or to report on), `notes`
 * says why, and the analysis reports nothing.
 */
export declare function impact(options?: ImpactOptions): Promise<Analysis>;

/** `flowpact generate`: writes, or with `dryRun` previews, the contracts in `.github/flowpact/`. */
export declare function generate(options?: GenerateOptions): Promise<ContractGeneration>;

/** `flowpact graph`: which workflows call which reusable workflows and local actions. */
export declare function graph(options?: GraphOptions): Promise<CallGraph>;

/** `flowpact trace`: where an input, secret or output flows to, or with `up`, where its value comes from. */
export declare function trace(options: TraceOptions): Promise<TraceResult>;

/** `flowpact rules`: every rule, with its effective severity. */
export declare function rules(options?: RulesOptions): Promise<RuleInfo[]>;

/** `flowpact explain`: a rule's documentation, by code (`FP401`) or name. */
export declare function explain(codeOrName: string, options?: ExplainOptions): Promise<RuleDocs>;

// ---------------------------------------------------------------------------------------------------------------------
// Text: what the commands print, from what they return. The same text as the CLI's for the same options, and like
// it, safe to print in a CI log: no line of it is read as a GitHub workflow command. Written for people; parse the
// data instead, its wording can change in any minor release.

export interface GraphFormatOptions extends TextOptions {
  /**
   * `tree` (default), as `flowpact graph` prints it; `mermaid`, a Mermaid flowchart without code fences; or `dot`,
   * Graphviz DOT. The other options apply to the tree.
   */
  format?: 'tree' | 'mermaid' | 'dot';
}

export interface GenerationFormatOptions extends TextOptions {
  /** Add the changes as a diff, as `flowpact generate --dry-run` prints them (colored with `color`). */
  diff?: boolean;
}

/** `flowpact graph` (`--format tree`, `mermaid` or `dot`). */
export declare function formatGraph(graph: CallGraph, options?: GraphFormatOptions): string;

/** `flowpact trace`: a tree per traced symbol, or why there is nothing to trace. */
export declare function formatTrace(result: TraceResult, options?: TextOptions): string;

/** `flowpact rules`: every rule by category, with its severity after the config. */
export declare function formatRules(rules: RuleInfo[], options?: TextOptions): string;

/** `flowpact explain`: the rule's documentation. */
export declare function formatExplain(rule: RuleDocs, options?: TextOptions): string;

/** `flowpact generate`: each contract file with its status and changes, then what was written, or after a `dryRun`, what would be. */
export declare function formatGeneration(
  generation: ContractGeneration,
  options?: GenerationFormatOptions,
): string;

/**
 * The options the CLI uses for its standard output, for text printed there. Colors: off with `NO_COLOR` or
 * `FORCE_COLOR=0`, on with `FORCE_COLOR`, else on in a terminal or in CI (the `CI` variable, set on GitHub Actions
 * runners; a `--color` or `--no-color` argument of the program decides too). Width: the terminal's, else `COLUMNS`,
 * from 40 to 140 columns (100 when neither is known). Hyperlinks: in a terminal with colors, unless
 * `FLOWPACT_NO_HYPERLINKS` is set.
 */
export declare function terminalOptions(): Required<TextOptions>;

// ---------------------------------------------------------------------------------------------------------------------
// Plugin rules (https://ciatlas.github.io/flowpact/docs/custom-rules)

/** Returns the rule as is; it gives a rule written in TypeScript its type. */
export declare function defineRule(rule: RuleDefinition): RuleDefinition;

export interface RuleDefinition {
  /** `<PREFIX><category digit><two digits>`, e.g. `ACME601`; the `FP` prefix is flowpact's. */
  code: string;
  /** kebab-case, e.g. `prod-deploy-needs-approval`. */
  name: string;
  /** Must match the code's category digit. */
  category: RuleCategory;
  defaultSeverity: SeveritySetting;
  docs: {
    /** One line, shown by `flowpact rules`. */
    summary: string;
    /** Why this matters, shown with every finding. */
    why: string;
    /** How to fix it, shown with every finding. */
    fix: string;
    /** What the rule deliberately leaves out, shown by `flowpact explain`. */
    scope?: string;
    examples?: { bad: string; good: string };
  };
  /** Where the rule is documented; required for plugin rules. */
  docsUrl?: string;
  /** `post` rules run after overrides were applied and see `ctx.overrides`; overrides cannot accept their findings. */
  phase?: 'main' | 'post';
  /** `skip` drops the rule's findings located in generated files. Default: `report`. */
  generatedFiles?: 'report' | 'skip';
  check(ctx: RuleContext): void;
}

export interface ReportInput {
  message: string;
  loc: Loc;
  related?: { loc: Loc; message: string }[];
  combos?: string[];
  /** The symbol the finding is about, e.g. `.github/workflows/deploy.yml#jobs.prod`. */
  symbol?: string;
  /** Advice for this finding instead of the rule's `docs.fix`. */
  fix?: string;
  /** Keep newlines in `fix`; only when no interpolated value can contain one. */
  fixMultiline?: boolean;
  /** Report this finding below the rule's severity; it never raises it. */
  severity?: Severity;
}

export interface RuleLogger {
  error(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  trace(message: string, data?: Record<string, unknown>): void;
}

export interface Override {
  rule: string;
  target?: string;
  file?: string;
  reason: string;
  expires?: string;
  owner?: string;
}

/** The resolved configuration: the repository's config on top of the base config and the defaults. */
export interface FlowpactConfig {
  version: number;
  repository?: string;
  rules: Record<string, SeveritySetting>;
  limits: { nestingDepth: number; maxInputs: number };
  ignore: string[];
  overrides: Override[];
  matrixShapes: Record<string, { keys: string[] }>;
  generated: { include: string[]; exclude: string[] };
  plugins: string[];
}

export interface RuleContext {
  /**
   * The data-flow graph: the parsed workflows and actions with exact locations, and who calls whom.
   *
   * Advanced and unstable: these types follow flowpact's internals and can change in any minor release, without the
   * notice the rest of this API gets. The members documented in Custom rules are the ones to use.
   */
  readonly index: ProjectIndex;
  readonly config: FlowpactConfig;
  readonly logger: RuleLogger;
  /** The config file, relative to the root, when there is one. */
  readonly configFile?: string;
  /** The comparison with the locked contracts; only in `check`. */
  readonly contracts?: {
    drift: boolean;
    breaking: number;
    counts: { create: number; update: number; delete: number; unchanged: number };
    entries: ContractEntry[];
    skipped: string[];
  };
  /** Impact mode's changes and verdict; only when impact mode runs. */
  readonly impact?: {
    baseline: ImpactVerdict['baseline'];
    changes: ImpactVerdict['changes'];
    verdict: { required: ImpactLevel; declared?: ImpactVerdict['declared']; ok: boolean };
    /** With paths: the only units graded, so `changes` and `verdict` are about them alone. */
    scope?: ImpactVerdict['scope'];
  };
  /** How each override was used; only for `post` rules. */
  readonly overrides?: {
    index: number;
    override: Override;
    loc?: Loc;
    matched: number;
    expired: boolean;
    daysLeft?: number;
    inactive?: boolean;
  }[];
  /** The expanded matrix of a job (cached). */
  matrix(unit: UnitDecl, job: JobDecl): MatrixExpansion;
  /** Whether a rule runs in this analysis: loaded, not turned off, and selected by `only` when that is given. */
  runs(code: string): boolean;
  report(input: ReportInput): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// The data-flow graph, for plugin rules. Advanced and unstable (see RuleContext.index).

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type UsesKind =
  | 'local-workflow'
  | 'remote-workflow'
  | 'local-action'
  | 'remote-action'
  | 'workspace-action'
  | 'docker';

export interface UsesRef {
  /** As written, e.g. `./.github/workflows/build.yml` or `actions/checkout@v4`. */
  raw: string;
  loc: Loc;
  kind: UsesKind;
  /** The target in this repository, for local references. */
  target?: string;
}

/** A `key: value` passed somewhere: `with`, `secrets`, `env`. */
export interface Binding {
  name: string;
  loc: Loc;
  valueLoc: Loc;
  value: JsonValue;
}

export interface InputDecl {
  name: string;
  type?: string;
  required: boolean;
  hasDefault: boolean;
  default?: JsonValue;
  /** Where the `default:` value is written. */
  defaultLoc?: Loc;
  /** The `default:` value's expression, when it has one (`${{ github.token }}`). */
  defaultSite?: ExprSite;
  description?: string;
  options?: string[];
  loc: Loc;
}

export interface SecretDecl {
  name: string;
  required: boolean;
  description?: string;
  loc: Loc;
}

export interface OutputDecl {
  name: string;
  description?: string;
  loc: Loc;
  value?: JsonValue;
}

export type PermissionsDecl = 'read-all' | 'write-all' | Record<string, 'read' | 'write' | 'none'>;

export interface StepDecl {
  index: number;
  id?: string;
  name?: string;
  loc: Loc;
  uses?: UsesRef;
  run?: string;
  with: Record<string, Binding>;
  env: Record<string, Binding>;
}

export interface JobDecl {
  id: string;
  loc: Loc;
  name?: string;
  permissions?: PermissionsDecl;
  needs: { id: string; loc: Loc }[];
  /** A reusable workflow the job calls. */
  uses?: UsesRef;
  with: Record<string, Binding>;
  secrets: Record<string, Binding>;
  secretsInherit: boolean;
  env: Record<string, Binding>;
  outputs: Record<string, OutputDecl>;
  /** The `strategy.matrix` as written; `ctx.matrix(unit, job)` expands it. */
  matrix?: unknown;
  steps: StepDecl[];
}

interface UnitBase {
  /** The workflow file, or the action's directory. */
  path: string;
  /** The file, relative to the root. */
  file: string;
  name?: string;
  /** Set when the file is generated, to the marker that says so. */
  generated?: string;
}

export interface WorkflowDecl extends UnitBase {
  kind: 'workflow';
  /** The events in `on:`. */
  triggers: string[];
  /** `on.workflow_call`. */
  call?: {
    loc: Loc;
    inputs: Record<string, InputDecl>;
    secrets: Record<string, SecretDecl>;
    outputs: Record<string, OutputDecl>;
  };
  /** `on.workflow_dispatch`. */
  dispatch?: { loc: Loc; inputs: Record<string, InputDecl> };
  env: Record<string, Binding>;
  permissions?: PermissionsDecl;
  jobs: Record<string, JobDecl>;
}

export interface ActionDecl extends UnitBase {
  kind: 'action';
  /** `runs.using`, e.g. `composite` or `node24`. */
  using?: string;
  inputs: Record<string, InputDecl>;
  outputs: Record<string, OutputDecl>;
  steps: StepDecl[];
}

export type UnitDecl = WorkflowDecl | ActionDecl;

export interface Project {
  root: string;
  repository?: string;
  workflows: ReadonlyMap<string, WorkflowDecl>;
  actions: ReadonlyMap<string, ActionDecl>;
}

/** A job that calls a reusable workflow. */
export interface CallSite {
  caller: WorkflowDecl;
  job: JobDecl;
  callee: WorkflowDecl;
}

/** A step that uses a local action. */
export interface ActionUse {
  unit: UnitDecl;
  job?: JobDecl;
  step: StepDecl;
  action: ActionDecl;
}

/** An expression in the YAML, such as `${{ inputs.config }}`. */
export interface ExprSite {
  file: string;
  /** e.g. `job.with`, `step.run`, `step.if`. */
  field: string;
  job?: string;
  step?: number;
  /** The key for keyed fields (`with`, `env`, `outputs`, `secrets`). */
  key?: string;
  text: string;
  loc: Loc;
  isCondition: boolean;
}

/** One place where a symbol is read. */
export interface Usage {
  symbol: string;
  site: ExprSite;
  /** The reference in the expression, e.g. `inputs.config`, and where it is. */
  ref: { context: string; path: string[]; dynamic: boolean; loc: Loc };
  /** The symbol the value flows on to, such as a called workflow's input. */
  sink?: string;
  /**
   * Set when the reference does not name the symbol: it reads a whole object (`toJSON(inputs)`, `needs.build.outputs`,
   * `toJSON(env)`) or indexes one with a computed key (`matrix[inputs.key]`, `secrets[inputs.name]`), and so reads every
   * member, this one among them. Such a read counts as a read of each member, but does not single one out: a rule
   * about how one input is read, such as how a condition treats it when it is empty, skips it.
   */
  whole?: true;
}

export interface ProjectIndex {
  readonly project: Project;
  /** Every job that calls a reusable workflow. */
  readonly callSites: readonly CallSite[];
  /** Every step that uses a local action. */
  readonly actionUses: readonly ActionUse[];
  units(): UnitDecl[];
  unit(path: string): UnitDecl | undefined;
  callersOf(workflowPath: string): CallSite[];
  usersOf(actionPath: string): ActionUse[];
  /**
   * Every place the symbol is read, e.g. `.github/workflows/ci.yml#inputs.config`, including reads of the whole object
   * it is a member of (see `Usage.whole`).
   */
  usagesOf(symbol: string): Usage[];
}

export interface MatrixExpansion {
  /** One per job the matrix creates; a value is unknown where it is an expression. */
  combos: {
    values: Record<string, { known: true; value: JsonValue } | { known: false }>;
    origin: 'product' | 'include';
  }[];
  /** Every key that appears in at least one combination. */
  keys: string[];
  /** False when part of the matrix is an expression, so the combinations may be incomplete. */
  exact: boolean;
  /** True when the whole matrix is an expression. */
  dynamic: boolean;
  /** True when there are too many combinations to list; `combos` is then empty. */
  truncated: boolean;
}
