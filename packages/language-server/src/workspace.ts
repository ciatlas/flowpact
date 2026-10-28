import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  type FileSystem,
  type Logger,
  nodeFileSystem,
  type Occurrence,
  overlayFileSystem,
  SymbolLocator,
} from '@ciatlas/core';
import {
  ACTIONS_LOCK_FILE,
  type AnalysisResult,
  analyze,
  CONFIG_DIR,
  CONFIG_FILES,
  CONTRACTS_DIR,
  ConfigError,
  contractOccurrences,
  createRegistry,
  defaultConfig,
  type LoadedConfig,
  loadPlugins,
  parseConfigText,
  type RuleRegistry,
  RuleRegistryError,
} from '@flowpact/lint';
import type { Diagnostic } from 'vscode-languageserver';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { pathToUri, toDiagnostic, toPosix } from './convert';
import { type RemoteBinding, RemoteBindings } from './remotes';
import type { Settings } from './settings';
import { type RemoteSources, webHostOf } from './sources';

/** Files the analysis reads: workflows, action metadata, flowpact's config and contracts, and GitHub's actions.lock. */
function isRelevant(rel: string): boolean {
  return (
    /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(rel) ||
    /(^|\/)action\.ya?ml$/i.test(rel) ||
    rel.startsWith(`${CONFIG_DIR}/`) ||
    rel === ACTIONS_LOCK_FILE
  );
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The repository a file belongs to: the nearest directory above it with a `.github` folder; without one anywhere above
 * (a repository of an action at its root), the root of the git repository it is in (`.git`: a folder, or a file in a
 * worktree or submodule).
 */
function findRoot(path: string): string | undefined {
  let gitRoot: string | undefined;
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    if (isDir(join(dir, '.github'))) return dir;
    gitRoot ??= existsSync(join(dir, '.git')) ? dir : undefined;
    if (dirname(dir) === dir) return gitRoot;
  }
}

/** A workspace folder to analyze at startup: one with a `.github` folder, or a git repository with an action at its root. */
const isRepository = (folder: string) =>
  isDir(join(folder, '.github')) ||
  (existsSync(join(folder, '.git')) &&
    ['action.yml', 'action.yaml'].some((f) => existsSync(join(folder, f))));

/** One analyzed repository: the latest result and what was published for it. */
export class Root {
  result?: AnalysisResult;
  locator?: SymbolLocator;
  /** The keys of remote calls whose interface the lockfile has, which the locator does not know. */
  remotes?: RemoteBindings;
  /** The host to link the sources of remote references on, when it is certain (see `webHostOf`). */
  webHost?: string | undefined;
  /** Paths that got diagnostics last time, so files whose findings are gone are cleared. */
  published = new Set<string>();
  /** The last config that parsed and analyzed cleanly, used while the config file is being edited. */
  goodConfig?: LoadedConfig;
  /** The config file the last analysis read (repo-relative), when there is one. */
  configFile?: string | undefined;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
  dirty = false;
  pluginsNoted = false;

  constructor(readonly dir: string) {}

  /** `path` relative to the root (POSIX), or undefined when it lies outside. */
  rel(path: string): string | undefined {
    const r = toPosix(relative(this.dir, path));
    return r && r !== '..' && !r.startsWith('../') && !isAbsolute(r) ? r : undefined;
  }
}

export interface WorkspaceHost {
  /** Open documents with their (possibly unsaved) text. */
  documents(): Iterable<{ path: string; text: string }>;
  publish(path: string, diagnostics: Diagnostic[]): void;
  /** The server's own messages. */
  logger: Logger;
  /** The analysis' stage-by-stage logs; quieter than `logger` unless debugging. */
  analysisLogger: Logger;
}

/** A config or plugin problem, reported on the config file. */
interface ConfigProblem {
  file: string;
  message: string;
}

/** A config or plugin error as a problem on the config file, or on the file it would be when there is none. */
function configProblem(configFile: string | undefined, err: Error): ConfigProblem {
  return {
    file: configFile ?? `${CONFIG_DIR}/${CONFIG_FILES[0]}`,
    message: [err.message, ...(err instanceof ConfigError ? err.issues : []).map((i) => `- ${i}`)].join('\n'),
  };
}

/** The config file as written; when it does not parse, the last good config, else the defaults. */
function readConfig(
  fs: FileSystem,
  configFile: string | undefined,
  goodConfig: LoadedConfig | undefined,
  problem: (err: Error) => void,
): LoadedConfig {
  const defaults: LoadedConfig = { config: defaultConfig() };
  if (!configFile) return defaults;
  const text = fs.read(configFile)!;
  try {
    return { ...parseConfigText(text, configFile), file: configFile, text };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    problem(err);
    return goodConfig ?? defaults;
  }
}

/** What an analysis of a root runs with, besides its config. */
interface AnalysisInput {
  dir: string;
  fs: FileSystem;
  registry: RuleRegistry;
  logger: Logger;
  checkContracts: boolean;
}

/**
 * The analysis with the first of `candidates` that it accepts (it rejects, for example, an unknown rule), and that
 * config; `rejected` hears of each config it rejects. Undefined when it rejects them all.
 */
function analyzeFirst(
  input: AnalysisInput,
  candidates: LoadedConfig[],
  rejected: (candidate: LoadedConfig, err: ConfigError) => void,
): { result: AnalysisResult; candidate: LoadedConfig } | undefined {
  for (const candidate of candidates) {
    try {
      const result = analyze({
        root: input.dir,
        fs: input.fs,
        config: candidate.config,
        ...(candidate.file ? { configFile: candidate.file } : {}),
        ...(candidate.text !== undefined ? { configText: candidate.text } : {}),
        ...(candidate.overrideLocs ? { overrideLocs: candidate.overrideLocs } : {}),
        registry: input.registry,
        logger: input.logger,
        checkContracts: input.checkContracts,
      });
      return { result, candidate };
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      rejected(candidate, err);
    }
  }
  return undefined;
}

/** Delay after the last edit before analyzing. */
const DEBOUNCE_MS = 200;

/**
 * Tracks the repositories open in the editor and keeps their analysis current: each edit re-runs the whole analysis
 * (fast enough for any real repository), so changing a callee updates its callers' diagnostics too.
 */
export class Workspace {
  private readonly roots = new Map<string, Root>();

  constructor(
    private readonly host: WorkspaceHost,
    private settings: Settings,
    private folders: string[],
    /** The remote sources cache (it moves with the settings): its files are another repository's, not analyzed. */
    private readonly sources: () => RemoteSources | undefined = () => undefined,
  ) {}

  /** Analyzes the workspace folders that are repositories, so their diagnostics show before any file is opened. */
  start(): void {
    for (const folder of this.folders) this.open(folder);
  }

  configure(settings: Settings): void {
    this.settings = settings;
    for (const root of this.roots.values()) this.schedule(root, 0);
  }

  addFolder(folder: string): void {
    this.folders.push(folder);
    this.open(folder);
  }

  /** Analyzes a workspace folder that is a repository, unless it is in the remote sources cache. */
  private open(folder: string): void {
    if (!this.sources()?.contains(folder) && isRepository(folder)) this.schedule(this.root(folder), 0);
  }

  removeFolder(folder: string): void {
    this.folders = this.folders.filter((f) => f !== folder);
    for (const root of [...this.roots.values()]) {
      const r = relative(folder, root.dir);
      if (r.startsWith('..') || isAbsolute(r)) continue;
      clearTimeout(root.timer);
      for (const path of root.published) this.host.publish(path, []);
      this.roots.delete(root.dir);
    }
  }

  /** A file was opened, edited, closed or changed on disk. */
  changed(path: string): void {
    const root = this.rootOf(path);
    if (root) this.schedule(root, DEBOUNCE_MS);
  }

  /**
   * The symbol at a position (1-based), after pending edits are analyzed; on a key of a remote call, also that key's
   * input or secret as the lockfile records it.
   */
  async locate(
    path: string,
    line: number,
    column: number,
  ): Promise<{ root: Root; at: Occurrence; remote?: RemoteBinding } | undefined> {
    const root = this.rootOf(path);
    const rel = root?.rel(path);
    if (!root || !rel) return undefined;
    await this.ready(root);
    const at = root.locator?.at(rel, line, column) ?? this.contractAt(path, rel, line, column);
    if (at) return { root, at };
    const remote = root.remotes?.at(rel, line, column);
    return remote ? { root, at: remote.at, remote } : undefined;
  }

  /** The analysis of the repository a file belongs to, after pending edits are analyzed. */
  async analysisOf(path: string): Promise<{ root: Root; result: AnalysisResult } | undefined> {
    const root = this.rootOf(path);
    if (!root?.rel(path)) return undefined;
    await this.ready(root);
    return root.result ? { root, result: root.result } : undefined;
  }

  /** The findings of the repository a file belongs to, after pending edits are analyzed. */
  async findingsOf(path: string): Promise<{ root: Root; findings: AnalysisResult['findings'] } | undefined> {
    const analysis = await this.analysisOf(path);
    return analysis && { root: analysis.root, findings: analysis.result.findings };
  }

  /**
   * A repository's config file (absolute), the one the analysis read or where a new one goes, and its text as the
   * editor has it (see `textOf`).
   */
  configOf(root: Root): { path: string; text: string | undefined } {
    const path = join(root.dir, root.configFile ?? `${CONFIG_DIR}/${CONFIG_FILES[0]}`);
    return { path, text: this.textOf(path) };
  }

  /** A file's text as the editor has it: the open document's, else the file's, else none. */
  textOf(path: string): string | undefined {
    const open = [...this.host.documents()].find((d) => d.path === path);
    if (open) return open.text;
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** In a contract file, what the contract names at a position (1-based): a unit, a job, an input, secret or output. */
  private contractAt(path: string, rel: string, line: number, column: number): Occurrence | undefined {
    if (!rel.startsWith(`${CONTRACTS_DIR}/`)) return undefined;
    const text = this.textOf(path);
    if (text === undefined) return undefined;
    return contractOccurrences(rel, text).find(
      (o) =>
        (o.loc.line < line || (o.loc.line === line && o.loc.column <= column)) &&
        (o.loc.endLine > line || (o.loc.endLine === line && o.loc.endColumn >= column)),
    );
  }

  /** Waits until every root's analysis reflects the latest edits. */
  async settled(): Promise<void> {
    await Promise.all([...this.roots.values()].map((r) => this.ready(r)));
  }

  private root(dir: string): Root {
    let root = this.roots.get(dir);
    if (!root) {
      root = new Root(dir);
      this.roots.set(dir, root);
      this.host.logger.info(`analyzing ${dir}`);
    }
    return root;
  }

  /** The root a relevant file belongs to; other files (and their roots) are ignored. */
  private rootOf(path: string): Root | undefined {
    if (this.sources()?.contains(path)) return undefined;
    const dir = findRoot(path);
    if (dir === undefined) return undefined;
    const rel = toPosix(relative(dir, path));
    return isRelevant(rel) ? this.root(dir) : undefined;
  }

  private schedule(root: Root, delay: number): void {
    clearTimeout(root.timer);
    root.timer = setTimeout(() => {
      root.timer = undefined;
      void this.run(root);
    }, delay);
  }

  private async ready(root: Root): Promise<void> {
    if (root.timer) {
      clearTimeout(root.timer);
      root.timer = undefined;
      await this.run(root);
    } else if (root.running) {
      await root.running;
    } else if (!root.result) {
      await this.run(root);
    }
  }

  private run(root: Root): Promise<void> {
    if (root.running) {
      root.dirty = true;
      return root.running;
    }
    root.running = (async () => {
      try {
        do {
          root.dirty = false;
          await this.analyze(root);
        } while (root.dirty);
      } catch (err) {
        // Keep the previous diagnostics; the log says what went wrong.
        this.host.logger.error(`analysis of ${root.dir} failed: ${(err as Error).message}`, {
          stack: (err as Error).stack,
        });
      } finally {
        root.running = undefined;
      }
    })();
    return root.running;
  }

  /** The open documents of a root that the analysis reads, with their (possibly unsaved) text. */
  private openFiles(root: Root): Map<string, string> {
    const files = new Map<string, string>();
    for (const doc of this.host.documents()) {
      const rel = root.rel(doc.path);
      if (rel && isRelevant(rel)) files.set(rel, doc.text);
    }
    return files;
  }

  /**
   * Whether the config's plugins may run. Plugins run JavaScript from the repository: only when the editor trusts the
   * workspace, and only for repositories in its folders (a file opened from elsewhere, or a repository above an opened
   * folder, was not trusted).
   */
  private pluginsAllowed(root: Root, loaded: LoadedConfig): boolean {
    if (loaded.config.plugins.length === 0) return false;
    const inFolders = this.folders.some((f) => {
      const r = relative(f, root.dir);
      return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
    });
    if (this.settings.plugins && inFolders) return true;
    this.notePluginsSkipped(root);
    return false;
  }

  /** The built-in rules and the config's plugins; only the built-in ones when the plugins fail to load. */
  private async registryWithPlugins(
    root: Root,
    loaded: LoadedConfig,
    problem: (err: Error) => void,
  ): Promise<RuleRegistry> {
    const registry = createRegistry();
    try {
      await loadPlugins(root.dir, loaded.config, registry, this.host.analysisLogger);
      return registry;
    } catch (err) {
      if (!(err instanceof ConfigError || err instanceof RuleRegistryError)) throw err;
      problem(err);
      return createRegistry();
    }
  }

  /** Says once per root that its config's plugins are not loaded, and why. */
  private notePluginsSkipped(root: Root): void {
    if (root.pluginsNoted) return;
    const why = this.settings.plugins ? 'the repository is outside the workspace folders' : 'plugins are off';
    this.host.logger.info(`${root.dir}: the config lists plugins; they are not loaded (${why})`);
    root.pluginsNoted = true;
  }

  private async analyze(root: Root): Promise<void> {
    const logger = this.host.logger;
    const fs = overlayFileSystem(nodeFileSystem(root.dir), this.openFiles(root));
    const problems: ConfigProblem[] = [];
    const configFile = CONFIG_FILES.map((f) => `${CONFIG_DIR}/${f}`).find((f) => fs.read(f) !== undefined);
    const problem = (err: Error) => problems.push(configProblem(configFile, err));
    root.configFile = configFile;
    const loaded = readConfig(fs, configFile, root.goodConfig, problem);
    // Without plugins to load the analysis starts in the same turn, with no await in between.
    const registry = this.pluginsAllowed(root, loaded)
      ? await this.registryWithPlugins(root, loaded, problem)
      : createRegistry();

    const checkContracts =
      this.settings.contracts === 'on' || (this.settings.contracts === 'auto' && fs.isDir(CONTRACTS_DIR));
    // The config as written; if the analysis rejects it (e.g. an unknown rule), the last good one, then the defaults.
    const candidates = [...new Set([loaded, root.goodConfig ?? loaded, { config: defaultConfig() }])];
    const analyzed = analyzeFirst(
      { dir: root.dir, fs, registry, logger: this.host.analysisLogger, checkContracts },
      candidates,
      (candidate, err) => {
        if (candidate === loaded) problem(err);
      },
    );
    if (!analyzed) return;
    const { result } = analyzed;
    if (analyzed.candidate === loaded && problems.length === 0) root.goodConfig = loaded;
    root.result = result;
    root.locator = new SymbolLocator(result.index);
    root.remotes = new RemoteBindings(result.index);
    root.webHost = webHostOf(root.dir);
    logger.debug(`analyzed ${root.dir}`, {
      findings: result.findings.length,
      ms: Math.round(result.durationMs),
    });
    this.publish(root, result, problems);
  }

  private publish(root: Root, result: AnalysisResult, problems: ConfigProblem[]): void {
    const hidden = new Set(this.settings.hiddenRules.map((c) => c.toUpperCase()));
    const byPath = new Map<string, Diagnostic[]>();
    const add = (file: string, d: Diagnostic) => {
      const path = join(root.dir, file);
      const list = byPath.get(path);
      if (list) list.push(d);
      else byPath.set(path, [d]);
    };
    const uriOf = (file: string) => pathToUri(join(root.dir, file));
    for (const f of result.findings) if (!hidden.has(f.code)) add(f.loc.file, toDiagnostic(f, uriOf));
    for (const p of problems) {
      add(p.file, {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        severity: DiagnosticSeverity.Error,
        source: 'flowpact',
        message: p.message,
      });
    }
    for (const path of root.published) if (!byPath.has(path)) this.host.publish(path, []);
    for (const [path, list] of byPath) this.host.publish(path, list);
    root.published = new Set(byPath.keys());
  }
}
