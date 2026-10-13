/**
 * The start of every API call and CLI command: the root, the logger and the config, and the rules to run. The public
 * functions (src/api.ts) and the CLI's commands are both built on these, so they cannot drift apart.
 */
import { resolve } from 'node:path';
import { createLogger, type Logger, type LogLevel, type LogSink, silentLogger } from '@ciatlas/core';
import {
  type AnalysisResult,
  type AnalyzeOptions,
  analyze,
  createRegistry,
  type LoadedConfig,
  loadConfig,
  loadPlugins,
  type RuleRegistry,
} from '@flowpact/lint';
import { attempt, attemptAsync, usage } from './errors';

/** Where log records go; without it, nothing is logged. */
export interface LogOption extends LogSink {
  /** Default: `info`. */
  level?: LogLevel;
}

/** Options of every function: the CLI's `--root`, `--config`, `--base-config` and logging flags. */
export interface CommonOptions {
  /** Repository root. Default: the working directory. */
  root?: string;
  /** Config file, relative to the working directory. Default: `.github/flowpact/flowpact.config.yml` under the root. */
  config?: string;
  /** Defaults under the repository's config, such as an organization's; relative to the working directory. */
  baseConfig?: string;
  log?: LogOption;
}

/** Options of the functions that load rules: the CLI's `--plugin` and `--no-plugins`. */
export interface PluginOptions {
  /** Plugins to load besides those the config lists, relative to the working directory (`--plugin`). */
  plugins?: string[];
  /** Load the plugins the repository's config lists, which runs the repository's code. Default: true. */
  repositoryPlugins?: boolean;
}

export interface Session {
  root: string;
  logger: Logger;
  loaded: LoadedConfig;
  /** Whether the plugins the config lists are loaded, and the other plugins to load (absolute paths). */
  plugins: { config: boolean; extra: string[] };
}

/** A list of strings, or a usage error naming the option. */
export function stringList(name: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    throw usage(`${name} must be an array of strings`);
  return value as string[];
}

/**
 * A boolean, or a usage error naming the option. A JavaScript caller may pass what `@actions/core` getInput returns,
 * the string "false", which must not count as true (for `repositoryPlugins`, that would run the repository's code).
 */
export function bool(name: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw usage(`${name} must be true or false (got ${JSON.stringify(value)})`);
  return value;
}

/** One of `options`, or a usage error naming the option. */
export function oneOf<T extends string>(name: string, value: unknown, options: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!options.includes(value as T))
    throw usage(`${name} must be one of ${options.join(', ')} (got ${JSON.stringify(value)})`);
  return value as T;
}

const LEVELS = ['silent', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** Resolves the root, creates the logger and loads the config (and base config). */
export function openSession(options: CommonOptions & PluginOptions = {}): Session {
  const log = options.log;
  if (log !== undefined && typeof log?.write !== 'function')
    throw usage('log must be an object with a write(record) function');
  const logger = log
    ? createLogger({ level: oneOf('log.level', log.level, LEVELS) ?? 'info', sink: log })
    : silentLogger;
  for (const name of ['root', 'config', 'baseConfig'] as const)
    if (options[name] !== undefined && typeof options[name] !== 'string')
      throw usage(`${name} must be a string`);
  const root = resolve(options.root ?? process.cwd());
  const loaded = attempt(() =>
    loadConfig(root, options.config, options.baseConfig !== undefined ? { base: options.baseConfig } : {}),
  );
  return {
    root,
    logger,
    loaded,
    plugins: {
      config: bool('repositoryPlugins', options.repositoryPlugins) !== false,
      extra: (stringList('plugins', options.plugins) ?? []).map((p) => resolve(process.cwd(), p)),
    },
  };
}

/** Built-in rules, the plugins the config lists (unless turned off) and the other plugins given. */
export async function loadRegistry(session: Session): Promise<RuleRegistry> {
  const { root, loaded, logger, plugins } = session;
  const registry = createRegistry();
  await attemptAsync(async () => {
    if (plugins.config) await loadPlugins(root, loaded.config, registry, logger);
    else if (loaded.config.plugins.length)
      logger.warn(`not loading ${loaded.config.plugins.length} plugin(s) from the config (--no-plugins)`);
    if (plugins.extra.length)
      await loadPlugins(root, { ...loaded.config, plugins: plugins.extra }, registry, logger);
  }, true);
  return registry;
}

/** Analyzes the session's root with its config, logger and the plugins it loads, and `options` on top. */
export async function analyzeSession(
  session: Session,
  options: Partial<AnalyzeOptions>,
): Promise<AnalysisResult> {
  const { root, loaded, logger } = session;
  const registry = await loadRegistry(session);
  return attempt(() =>
    analyze({
      root,
      config: loaded.config,
      ...(loaded.file ? { configFile: loaded.file } : {}),
      ...(loaded.text !== undefined ? { configText: loaded.text } : {}),
      ...(loaded.overrideLocs ? { overrideLocs: loaded.overrideLocs } : {}),
      logger,
      registry,
      ...options,
    }),
  );
}
