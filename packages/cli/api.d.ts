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
  /**
   * Fetch the interfaces of the remote workflows and actions the remote interfaces lockfile lacks, for this run only
   * (`--fetch-remotes`), with `token`. With a base, also grade the remote references the change moves to another
   * version, as the action's `remotes: fetch` does: see {@link Analysis.versionChanges}. Default: false.
   */
  fetchRemotes?: boolean;
  /**
   * With `fetchRemotes`, the token to read the remote repositories with, sent only to `apiUrl`. Default: `GH_TOKEN`,
   * else `GITHUB_TOKEN`, else the GitHub CLI's (`gh auth token`); none for public repositories only.
   */
  token?: string;
  /** With `fetchRemotes`, the GitHub API. Default: `GITHUB_API_URL`, else `https://api.github.com`. */
  apiUrl?: string;
  /**
   * With `fetchRemotes` on GitHub Enterprise Server or GHE.com, also look on github.com for the references the
   * enterprise server lacks, as GitHub Connect does, with `GITHUB_COM_TOKEN` or none, never `token` (`--github-com`).
   * It sends their names to github.com. Default: false.
   */
  githubCom?: boolean;
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

/** Options of `remotesUpdate` and `remotesDownload`: how to read the remote repositories. */
export interface RemotesFetchOptions extends CommonOptions {
  /**
   * Workflow and action files or directories, relative to the root: only the remote references they use, and those of
   * the local workflows and actions they call. Default: all.
   */
  paths?: string[];
  /**
   * The token to read the remote repositories with, sent only to `apiUrl`. Default: `GH_TOKEN`, else `GITHUB_TOKEN`,
   * else the GitHub CLI's (`gh auth token`); none for public repositories only.
   */
  token?: string;
  /** The GitHub API. Default: `GITHUB_API_URL`, else `https://api.github.com`. */
  apiUrl?: string;
  /**
   * On GitHub Enterprise Server or GHE.com, also look on github.com for the references the enterprise server lacks, as
   * GitHub Connect does, with `GITHUB_COM_TOKEN` or none, never `token` (`--github-com`). It sends their names to
   * github.com. Default: false.
   */
  githubCom?: boolean;
  /** Called as each reference is done, for a progress display. */
  onProgress?: (progress: RemoteProgress) => void;
}

/** One remote reference done, of how many. */
export interface RemoteProgress {
  done: number;
  total: number;
  ref: string;
  /** `cached` and `skipped` are `remotesDownload`'s: the cache had the source, or it was not downloaded. */
  outcome: 'fetched' | 'unreadable' | 'failed' | 'cached' | 'skipped';
  /** The commit, or why it could not be fetched or downloaded. */
  detail: string;
}

export interface RemotesUpdateOptions extends RemotesFetchOptions {
  /** Compute the lockfile without writing it, or anything to the cache (`--dry-run`). */
  dryRun?: boolean;
  /**
   * flowpact's cache directory, whose `remotes` directory keeps the files read, for the editor (`--cache-dir`; relative
   * to the working directory); `false` keeps none (`--no-cache`). Default: `FLOWPACT_CACHE_DIR`, else none in CI (`CI`,
   * `TF_BUILD` or `JENKINS_URL` set), else the per-user cache.
   */
  cacheDir?: string | false;
}

export interface RemotesDownloadOptions extends RemotesFetchOptions {
  /**
   * flowpact's cache directory, whose `remotes` directory the sources go to (`--cache-dir`; relative to the working
   * directory). Default: `FLOWPACT_CACHE_DIR`, else the per-user cache, also in CI.
   */
  cacheDir?: string;
}

export interface RemotesCleanOptions {
  /** flowpact's cache directory (`--cache-dir`). Default: `FLOWPACT_CACHE_DIR`, else the per-user cache. */
  cacheDir?: string;
  /** Keep this many of the most recently used commits of each repository (`--keep`). Default: 0, none. */
  keep?: number;
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
  /**
   * Fixes flowpact can apply, such as renaming a misspelled name, each with the edits that make it: the text at `loc`
   * replaced by `newText` (an empty range inserts it). Only when the change is certain.
   */
  suggestions?: { title: string; edits: { loc: Loc; newText: string }[] }[];
}

/** A finding an override accepted. */
export interface SuppressedFinding extends Finding {
  override: { index: number; reason: string; expires?: string; owner?: string };
}

/** A finding a `# flowpact: ignore[…]` comment accepted: the comment's location, and its reason when it gives one. */
export interface IgnoredFinding extends Finding {
  comment: { loc: Loc; reason?: string };
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
  /**
   * Only when `ignore` left out published workflows or actions (within the paths): those units, which were not graded,
   * as both the baseline's and the pull request's `ignore` match them.
   */
  ignored?: string[];
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
    /** Findings accepted by `# flowpact: ignore[…]` comments (not counted above). */
    ignoredByComment?: number;
    /** Findings not reported because they are about the internals of generated files. */
    skippedInGenerated?: number;
  };
  findings: Finding[];
  suppressed: SuppressedFinding[];
  /** Findings accepted by `# flowpact: ignore[…]` comments, each with the comment that accepted it. */
  ignoredByComment?: IgnoredFinding[];
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
  /**
   * What the CLI prints as `impact: …` lines: impact mode skipped, notes about its baseline and how it graded, and the
   * paths it does not refuse though they name no workflow or action. With `fetchRemotes`, also `version changes: …`
   * lines: why they were not graded.
   */
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
  /**
   * `lint` and `check` with `fetchRemotes`: the remote references the change moves to another version
   * (`octo/setup@v2` → `@v3`), graded against the repository's calls, as the action's `remotes: fetch` grades them.
   * The base is `base`, else in GitHub Actions the pull request's base commit; it must be in the clone, and `notes`
   * says when it is not. Undefined without a base, and on `pull_request_target` and `workflow_run`, whose checkout may
   * be untrusted. `exitCode()`, `pretty()` and `markdown()` include them; the other reports are about the findings.
   */
  readonly versionChanges?: VersionChanges;
  /**
   * The CLI's exit code for `--fail-on` (default `error`): 1 when there are findings at that level, or, unless it is
   * `never`, when a version change breaks a call.
   */
  exitCode(failOn?: FailOn): 0 | 1;
  annotations(options?: PathPrefixOptions): Annotation[];
  /**
   * The annotations as GitHub workflow commands, one line each (`--format github`): printed in a GitHub Actions step,
   * they annotate the run and the pull request. Every value in them is escaped.
   */
  github(options?: PathPrefixOptions): string;
  /** SARIF 2.1.0, for code scanning. */
  sarif(options?: PathPrefixOptions): string;
  /**
   * The Markdown report, for job summaries and pull request comments; with a Version changes section, as the action's
   * job summary has, when `versionChanges` graded a change or could not fetch one.
   */
  markdown(options?: MarkdownOptions): string;
  /** The JSON report as `--format json` prints it; `includeGraph` adds the data-flow graph. */
  json(options?: { includeGraph?: boolean }): string;
  /**
   * The terminal report (`--format pretty`); with the version changes after it when `versionChanges` graded a change or
   * could not fetch one.
   */
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

/** A remote reference and why it could not be fetched. */
export interface RemoteProblem {
  ref: string;
  error: string;
}

/** What `remotesUpdate` wrote to the remote interfaces lockfile, or with `dryRun` would write. */
export interface RemotesUpdateResult {
  /** The lockfile, relative to the root. */
  file: string;
  /** Whether its text changes. */
  changes: boolean;
  dryRun: boolean;
  /** References whose entry is new, changed (another commit or interface), or gone because nothing uses them. */
  added: string[];
  changed: string[];
  removed: string[];
  /** References that could not be fetched (the network, the API, the file); their previous entries are kept. */
  failed: RemoteProblem[];
  /** References that do not exist, or the token cannot read; recorded under the lockfile's `unreadable`. */
  unreadable: RemoteProblem[];
  /** Where the token came from (`GH_TOKEN`, `GITHUB_TOKEN`, the GitHub CLI, the option); undefined without one. */
  tokenSource?: string;
  /** The sources cache, unless none was kept. */
  sources?: {
    dir: string;
    /** Files written to it, and older commits removed afterwards (the 3 most recently used of each repository stay). */
    written: number;
    removed: number;
    /** Files that could not be written, and why the first one could not; the lockfile is written all the same. */
    notKept: number;
    failed?: string;
  };
  /** Why no file was kept although that was not asked for: in CI, or without a home directory. */
  sourcesNotKept?: string;
  /** Each changed entry graded against the repository's calls: what the new interface does to them. */
  grades: RemoteChangeGrade[];
  /**
   * GitHub's `actions.lock`, when the repository has one: how many references were read at the commits it pins (they
   * run whatever their tag points at now), or why it is not used.
   */
  actionsLock?: { file: string; pinned: number; error?: string };
}

/**
 * The remote references the change moves to another version, graded against every call of the repository. The
 * interface before is the base's lockfile entry, else the replaced reference fetched; the one after is always fetched,
 * never read from the working tree's lockfile, which could hide a break.
 */
export interface VersionChanges {
  /** The base commit they are compared with. */
  base: string;
  /** Each reference of the working tree that replaced another version (`from`) of the same workflow or action. */
  changes: { ref: string; from: string }[];
  /** One per change whose interfaces before and after could be read. */
  grades: RemoteChangeGrade[];
  /** References that could not be fetched: their changes are not graded. */
  failed: RemoteProblem[];
}

/**
 * What a version change does to a call. `breaks`: a check fails with the new interface that passed with the old one.
 * `unchecked`: none fails, but part of the change is out of the checks' reach for this call. `fits`: every check passes
 * as before.
 */
export type RemoteVerdict = 'breaks' | 'unchecked' | 'fits';

/** A call of a remote reference: a job that calls the reusable workflow, or a step that uses the action. */
export interface RemoteCallSite {
  /** The file of the workflow or action that makes the call. */
  file: string;
  job?: string;
  /** The step's id, or `#<n>` (1-based) without one. */
  step?: string;
  /** Where the call's `uses:` is. */
  loc: Loc;
}

export interface RemoteCallGrade {
  call: RemoteCallSite;
  verdict: RemoteVerdict;
  /** Findings with the new interface the old one did not give: why it breaks. */
  added: Finding[];
  /** Findings the old interface gave that the new one does not. */
  removed: Finding[];
  /** What the checks cannot tell about this call after the change: why the verdict is `unchecked` (kept with `breaks`). */
  unchecked: string[];
  /** Changes in behaviour the call gets without a check failing: a default it relies on changed. */
  notes: string[];
}

/** A changed lockfile entry, graded against every call of its reference in the repository. */
export interface RemoteChangeGrade {
  ref: string;
  /** The commits the entries record: before (none without an entry) and after. */
  commits: { before?: string; after: string };
  /** The worst verdict of its calls; `fits` when nothing calls it. */
  verdict: RemoteVerdict;
  /** The interface diff, which explains the verdict (it never decides it); empty without an earlier entry. */
  changes: ContractChange[];
  calls: RemoteCallGrade[];
}

/** What `remotesDownload` put in the sources cache. */
export interface RemotesDownloadResult {
  /** The lockfile, relative to the root, and the cache's directory. */
  file: string;
  dir: string;
  /** References whose source was downloaded, and those whose source the cache had. */
  downloaded: string[];
  cached: string[];
  /** References the lockfile has no entry for: `remotesUpdate` adds them. */
  notLocked: string[];
  /** References not downloaded, with why: recorded as unreadable, on a host this run does not read, an unsafe path. */
  skipped: { ref: string; reason: string }[];
  /** References whose source could not be downloaded or cached; `cache` when writing the cache failed. */
  failed: { ref: string; error: string; cache?: true }[];
  /** The cached commits this run used (`owner/repo/sha`), and older commits removed afterwards. */
  commits: string[];
  removed: number;
  tokenSource?: string;
}

/** What `remotesClean` removed from the sources cache. */
export interface RemotesCleanResult {
  dir: string;
  keep: number;
  /** Cached commits removed, and why one could not be. */
  removed: number;
  failed?: string;
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
   * How the value got here from the parent node: the expression (`text`) at `loc`, or `workflow output` (a reusable
   * workflow's), `action output` (an action's) or `secrets: inherit`. `note` qualifies it:
   * - `when dispatched`: upstream, a workflow input read through `github` (`github.event.inputs.<name>`, or a whole or
   *   computed `github` such as `toJSON(github)`) in a workflow that can also be called. The input holds the value only
   *   when the workflow is dispatched (a called workflow gets its caller's `github` context), so it is not traced
   *   further up; a `context` leaf stands for the called case;
   * - `the default of inputs.<name>`: upstream, an input or variable that the default of `inputs.<name>` reads;
   * - `exposed to the caller`: downstream, an output of a reusable workflow or action that becomes the output of the
   *   job or step that uses it;
   * - `jobs.<id>`: the job whose `secrets: inherit` passes the secret on.
   */
  via?: { loc: Loc; text: string; note?: string };
  /**
   * Downstream, the symbols the value flows to; upstream, the symbols it is computed from. A whole or computed read
   * (`toJSON(inputs)`, `matrix[inputs.key]`, `secrets[inputs.name]`, `toJSON(env)`) reads every member the files
   * declare: one child each. In a workflow that can be dispatched, a whole or computed `github` (`toJSON(github)`,
   * `github.event[x]`) reads each of its `workflow_dispatch` inputs, which `github.event.inputs` holds. A whole
   * `secrets` also reads each secret the workflow reads by name or is passed by name, and `GITHUB_TOKEN`; in a workflow
   * that callers hand every secret to through `secrets: inherit`, also each secret those callers declare, read by name
   * or are passed by name. Both ways, `secrets: inherit` follows a secret to the other workflow's own spelling of it
   * (names ignore case): the one it declares, else each spelling it reads or a caller passes it by. It never hands on
   * `GITHUB_TOKEN`. Downstream, a caller's secret goes through `secrets: inherit` into a callee that reads, or may
   * read, every secret, itself or further down (an expression that does not parse, or a remote workflow it hands every
   * secret on to, may).
   */
  children: TraceNode[];
  /**
   * Downstream, where the value is used, e.g. `run script` or `condition`. Upstream, where it comes from when that is
   * not another symbol: `literal` (a plain value: passed by a caller or a step, an env variable's or output's own
   * value, or an input's default), `omitted` (a caller or step does not pass the input), `value`, `missing` or
   * `dynamic` (a matrix key's combinations), `context` (read from a context flowpact does not follow, such as
   * `github.event.pull_request.title`; `github` in a workflow that can be called (`github.event.inputs.<name>`,
   * `toJSON(github)`), which then is the caller's; or a whole object that may hold members the files do not declare,
   * such as `toJSON(secrets)`, `toJSON(env)`, `toJSON(github)` or an action's `toJSON(inputs)`, next to the members it
   * reads; `text` is the reference as written),
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
 * When impact mode is skipped (on `merge_group`, or when there is nothing to grade or to report on: paths that hold
 * only what the change removed, or an `ignore` that matches every workflow and action), `notes` says why, and the
 * analysis reports nothing.
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

/**
 * `flowpact remotes update`: fetches the interfaces of the remote workflows and actions the repository uses into the
 * remote interfaces lockfile, and keeps the files read in the sources cache.
 */
export declare function remotesUpdate(options?: RemotesUpdateOptions): Promise<RemotesUpdateResult>;

/**
 * `flowpact remotes download`: downloads the sources of the commits the lockfile pins into the sources cache, without
 * changing the lockfile. Without a lockfile, or with one it cannot use, it throws a usage error.
 */
export declare function remotesDownload(options?: RemotesDownloadOptions): Promise<RemotesDownloadResult>;

/** `flowpact remotes clean`: empties the sources cache, or keeps the most recently used commits of each repository. */
export declare function remotesClean(options?: RemotesCleanOptions): Promise<RemotesCleanResult>;

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

/** `flowpact remotes update`: what the lockfile gained, lost or changed, the token, the cache, and what failed. */
export declare function formatRemotesUpdate(result: RemotesUpdateResult, options?: TextOptions): string;

/** `flowpact remotes download`: what the cache now has, and each reference not downloaded, with why. */
export declare function formatRemotesDownload(result: RemotesDownloadResult, options?: TextOptions): string;

/** `flowpact remotes clean`: how many cached commits went, and what was kept. */
export declare function formatRemotesClean(result: RemotesCleanResult, options?: TextOptions): string;

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
  /**
   * `post` rules run after overrides and ignore comments were applied and see `ctx.overrides` and `ctx.ignoreComments`;
   * neither can accept their findings.
   */
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
  /** How each rule of each `# flowpact: ignore[…]` comment was used; only for `post` rules. */
  readonly ignoreComments?: {
    comment: {
      loc: Loc;
      /** The line whose findings it accepts; 0 when no line of YAML follows a comment alone on its line. */
      line: number;
      rules: { key: string; loc: Loc }[];
      reason?: string;
      malformed?: string;
    };
    /** The rule as the comment names it; none for a malformed comment. */
    rule?: { key: string; loc: Loc };
    code?: string;
    invalid?: string;
    matched: number;
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
   *
   * In a workflow that can be dispatched, a read through `github` (`github.event.inputs.<name>`, or a whole or computed
   * `toJSON(github)`, `github.event[x]`) is a usage of its `workflow_dispatch` inputs, which `github.event.inputs` holds
   * when it is dispatched. In a workflow that can also be called, `github` is then the caller's, so such a usage never
   * takes in what a caller passes in `with:` (`ref.context` is `github`, or the usage reads a step's own `env:` value
   * that reads `github`). A read through `github` in the workflow's own input defaults or `workflow_call` outputs is no
   * usage: GitHub evaluates them only when the workflow is called.
   *
   * In a workflow, a whole or computed `secrets` (`toJSON(secrets)`, `secrets[inputs.name]`) is a usage of each secret
   * the workflow declares, reads by name or is passed by name, of its `GITHUB_TOKEN`, and, when callers hand it every
   * secret through `secrets: inherit`, of each secret they declare, read by name or are passed by name.
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
