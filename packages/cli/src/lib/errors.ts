import { ConfigError, ImpactSetupError, RuleRegistryError, UnsafePathError } from '@flowpact/lint';

/**
 * What went wrong, for a program to act on:
 * - `usage`: an option or path that cannot work (the CLI's exit code 2);
 * - `config`: the config or base config is invalid, or names a rule that does not exist;
 * - `plugin`: a plugin is missing, fails to load, exports no rules or registers an invalid rule;
 * - `unsafe-path`: a write through a symlink, or out of the repository, was refused;
 * - `impact-setup`: impact mode has no baseline or cannot read it.
 */
export type FlowpactErrorKind = 'usage' | 'config' | 'plugin' | 'unsafe-path' | 'impact-setup';

/** An expected failure of the API: what the CLI reports with exit code 2. Anything else is a bug (exit code 3). */
export class FlowpactError extends Error {
  readonly kind: FlowpactErrorKind;
  /** The config file the error is about, when there is one. */
  readonly file?: string;
  /** The individual problems (config errors list one per invalid entry); may be empty. */
  readonly issues: string[];

  constructor(
    kind: FlowpactErrorKind,
    message: string,
    options: { file?: string | undefined; issues?: string[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FlowpactError';
    this.kind = kind;
    if (options.file !== undefined) this.file = options.file;
    this.issues = options.issues ?? [];
  }
}

/**
 * `trace` found no symbol: a usage error whose message names the files that have an interface to trace. The CLI turns
 * `traceable` into suggested commands; `issues` stays for problems, so it is empty here.
 */
export class NoSymbolMatchError extends FlowpactError {
  constructor(
    message: string,
    readonly traceable: string[],
  ) {
    super('usage', message);
  }
}

/** The engine's expected errors as a FlowpactError; `plugin` for errors raised while loading plugins. */
export function toFlowpactError(err: unknown, plugin = false): unknown {
  if (err instanceof FlowpactError) return err;
  if (err instanceof ConfigError)
    return new FlowpactError(plugin ? 'plugin' : 'config', err.message, {
      file: err.file,
      issues: err.issues,
      cause: err,
    });
  if (err instanceof RuleRegistryError) return new FlowpactError('plugin', err.message, { cause: err });
  if (err instanceof UnsafePathError) return new FlowpactError('unsafe-path', err.message, { cause: err });
  if (err instanceof ImpactSetupError) return new FlowpactError('impact-setup', err.message, { cause: err });
  return err;
}

/** Runs `fn`, turning the engine's expected errors into FlowpactErrors. */
export function attempt<T>(fn: () => T, plugin = false): T {
  try {
    return fn();
  } catch (err) {
    throw toFlowpactError(err, plugin);
  }
}

export async function attemptAsync<T>(fn: () => Promise<T>, plugin = false): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toFlowpactError(err, plugin);
  }
}

export const usage = (message: string, issues?: string[]) =>
  new FlowpactError('usage', message, issues ? { issues } : {});
