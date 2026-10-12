import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  type Logger,
  nodeFileSystem,
  type Occurrence,
  overlayFileSystem,
  SymbolLocator,
} from '@flowpact/core';
import {
  type AnalysisResult,
  analyze,
  CONFIG_DIR,
  CONFIG_FILES,
  CONTRACTS_DIR,
  ConfigError,
  createRegistry,
  defaultConfig,
  type LoadedConfig,
  loadPlugins,
  parseConfigText,
  RuleRegistryError,
} from '@flowpact/lint';
import type { Diagnostic } from 'vscode-languageserver';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { pathToUri, toDiagnostic, toPosix } from './convert';
import type { Settings } from './settings';

/** Files the analysis reads: workflows, action metadata, and flowpact's config and contracts. */
function isRelevant(rel: string): boolean {
  return (
    /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(rel) ||
    /(^|\/)action\.ya?ml$/i.test(rel) ||
    rel.startsWith(`${CONFIG_DIR}/`)
  );
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The repository a file belongs to: the nearest directory above it with a `.github` folder. */
function findRoot(path: string): string | undefined {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    if (isDir(join(dir, '.github'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** One analyzed repository: the latest result and what was published for it. */
export class Root {
  result?: AnalysisResult;
  locator?: SymbolLocator;
  /** Paths that got diagnostics last time, so files whose findings are gone are cleared. */
  published = new Set<string>();
  /** The last config that parsed and analyzed cleanly, used while the config file is being edited. */
  goodConfig?: LoadedConfig;
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
  ) {}

  /** Analyzes the workspace folders that are repositories, so their diagnostics show before any file is opened. */
  start(): void {
    for (const folder of this.folders)
      if (isDir(join(folder, '.github'))) this.schedule(this.root(folder), 0);
  }

  configure(settings: Settings): void {
    this.settings = settings;
    for (const root of this.roots.values()) this.schedule(root, 0);
  }

  addFolder(folder: string): void {
    this.folders.push(folder);
    if (isDir(join(folder, '.github'))) this.schedule(this.root(folder), 0);
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

  /** The symbol at a position (1-based), after pending edits are analyzed. */
  async locate(
    path: string,
    line: number,
    column: number,
  ): Promise<{ root: Root; at: Occurrence } | undefined> {
    const root = this.rootOf(path);
    const rel = root?.rel(path);
    if (!root || !rel) return undefined;
    await this.ready(root);
    const at = root.locator?.at(rel, line, column);
    return at ? { root, at } : undefined;
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

  private async analyze(root: Root): Promise<void> {
    const logger = this.host.logger;
    const files = new Map<string, string>();
    for (const doc of this.host.documents()) {
      const rel = root.rel(doc.path);
      if (rel && isRelevant(rel)) files.set(rel, doc.text);
    }
    const fs = overlayFileSystem(nodeFileSystem(root.dir), files);
    const problems: ConfigProblem[] = [];
    const configFile = CONFIG_FILES.map((f) => `${CONFIG_DIR}/${f}`).find((f) => fs.read(f) !== undefined);
    const problem = (err: Error) =>
      problems.push({
        file: configFile ?? `${CONFIG_DIR}/${CONFIG_FILES[0]}`,
        message: [err.message, ...(err instanceof ConfigError ? err.issues : []).map((i) => `- ${i}`)].join(
          '\n',
        ),
      });

    let loaded: LoadedConfig = { config: defaultConfig() };
    if (configFile) {
      const text = fs.read(configFile)!;
      try {
        loaded = { ...parseConfigText(text, configFile), file: configFile, text };
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        problem(err);
        loaded = root.goodConfig ?? loaded;
      }
    }

    // Plugins run JavaScript from the repository: only when the editor trusts the workspace, and only for repositories
    // in its folders (a file opened from elsewhere, or a repository above an opened folder, was not trusted).
    let registry = createRegistry();
    const inFolders = this.folders.some((f) => {
      const r = relative(f, root.dir);
      return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
    });
    const loadable = this.settings.plugins && inFolders;
    const pluginsSkipped = loaded.config.plugins.length > 0 && !loadable;
    if (pluginsSkipped && !root.pluginsNoted) {
      const why = this.settings.plugins
        ? 'the repository is outside the workspace folders'
        : 'plugins are off';
      logger.info(`${root.dir}: the config lists plugins; they are not loaded (${why})`);
      root.pluginsNoted = true;
    }
    if (loaded.config.plugins.length > 0 && loadable) {
      try {
        await loadPlugins(root.dir, loaded.config, registry, this.host.analysisLogger);
      } catch (err) {
        if (!(err instanceof ConfigError || err instanceof RuleRegistryError)) throw err;
        problem(err);
        registry = createRegistry();
      }
    }

    const checkContracts =
      this.settings.contracts === 'on' || (this.settings.contracts === 'auto' && fs.isDir(CONTRACTS_DIR));
    // The config as written; if the analysis rejects it (e.g. an unknown rule), the last good one, then the defaults.
    const candidates = [...new Set([loaded, root.goodConfig ?? loaded, { config: defaultConfig() }])];
    let result: AnalysisResult | undefined;
    for (const candidate of candidates) {
      try {
        result = analyze({
          root: root.dir,
          fs,
          config: candidate.config,
          ...(candidate.file ? { configFile: candidate.file } : {}),
          ...(candidate.text !== undefined ? { configText: candidate.text } : {}),
          ...(candidate.overrideLocs ? { overrideLocs: candidate.overrideLocs } : {}),
          registry,
          logger: this.host.analysisLogger,
          checkContracts,
        });
        if (candidate === loaded && problems.length === 0) root.goodConfig = loaded;
        break;
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        if (candidate === loaded) problem(err);
      }
    }
    if (!result) return;
    root.result = result;
    root.locator = new SymbolLocator(result.index);
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
