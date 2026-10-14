import { isAbsolute } from 'node:path';
import type { LogLevel } from '@ciatlas/core';

/** What the client configures, through `initializationOptions` and `workspace/didChangeConfiguration`. */
export interface Settings {
  /**
   * Load the plugins listed in the config. They run JavaScript from the repository, so this is off unless the client
   * says the workspace is trusted.
   */
  plugins: boolean;
  /** Compare with the locked contracts: `auto` when `.github/flowpact/contracts/` exists. */
  contracts: 'auto' | 'on' | 'off';
  /** Rule codes not shown, e.g. those another extension already reports. */
  hiddenRules: string[];
  logLevel: LogLevel;
  /**
   * flowpact's cache directory (an absolute path), whose `remotes` directory holds the sources Go to Definition opens, as
   * `flowpact remotes update --cache-dir` keeps them; by default `FLOWPACT_CACHE_DIR`, else the per-user cache.
   */
  cacheDir?: string | undefined;
}

export const DEFAULT_SETTINGS: Settings = {
  plugins: false,
  contracts: 'auto',
  hiddenRules: [],
  logLevel: 'info',
};

const LOG_LEVELS: LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug', 'trace'];

/** Reads settings sent by a client, keeping `base` for anything missing or invalid. */
export function readSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    plugins: typeof r.plugins === 'boolean' ? r.plugins : base.plugins,
    contracts:
      r.contracts === 'auto' || r.contracts === 'on' || r.contracts === 'off' ? r.contracts : base.contracts,
    hiddenRules:
      Array.isArray(r.hiddenRules) && r.hiddenRules.every((c) => typeof c === 'string')
        ? (r.hiddenRules as string[])
        : base.hiddenRules,
    logLevel: LOG_LEVELS.includes(r.logLevel as LogLevel) ? (r.logLevel as LogLevel) : base.logLevel,
    ...cacheDirOf(r.cacheDir, base.cacheDir),
  };
}

/** The `cacheDir` setting: an absolute path; an empty (or relative) one clears it, a missing one keeps the old one. */
function cacheDirOf(raw: unknown, base: string | undefined): Pick<Settings, 'cacheDir'> {
  if (typeof raw !== 'string') return base ? { cacheDir: base } : {};
  return isAbsolute(raw) ? { cacheDir: raw } : {};
}
