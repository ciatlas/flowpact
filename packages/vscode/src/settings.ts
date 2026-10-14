// No `vscode` import here: this module decides what the server is told and is unit-tested outside the editor.
import type { Settings } from '@flowpact/language-server';

/** Rules that repeat checks GitHub's GitHub Actions extension makes: expressions, schema, YAML and contexts. */
const OVERLAPPING_RULES: ReadonlySet<string> = new Set(['FP502', 'FP503', 'FP504', 'FP505']);

/** The `flowpact.*` settings. */
export interface ExtensionSettings {
  plugins: boolean;
  contracts: Settings['contracts'];
  overlappingRules: 'auto' | 'show' | 'hide';
  hiddenRules: string[];
}

export interface Environment {
  /** Whether the workspace is trusted: plugins run JavaScript from the repository. */
  trusted: boolean;
  /** The flowpact output channel's log level, as VS Code's `LogLevel` (0 off … 5 error). */
  logLevel: number;
}

const LOG_LEVELS: Settings['logLevel'][] = ['silent', 'trace', 'debug', 'info', 'warn', 'error'];

/** What the language server is told, given the user's settings and the editor's state. */
export function serverSettings(s: ExtensionSettings, env: Environment): Settings {
  const hidden = s.hiddenRules.map((r) => r.trim().toUpperCase()).filter(Boolean);
  if (s.overlappingRules === 'hide') hidden.push(...OVERLAPPING_RULES);
  return {
    plugins: s.plugins && env.trusted,
    contracts: s.contracts,
    hiddenRules: [...new Set(hidden)],
    logLevel: LOG_LEVELS[env.logLevel] ?? 'info',
  };
}

/**
 * Whether to drop FP502–FP505 from files opened in the editor. GitHub's extension reports the same problems, but only
 * for files opened in the editor and only in trusted workspaces (it does not run in Restricted Mode).
 */
export function hidesOverlapInOpenedFiles(
  s: Pick<ExtensionSettings, 'overlappingRules'>,
  env: { trusted: boolean; githubActions: boolean },
): boolean {
  return s.overlappingRules === 'auto' && env.trusted && env.githubActions;
}

/** A diagnostic's rule code; VS Code turns a code with a docs link into `{ value, target }`. */
export function codeOf(d: { code?: string | number | { value: string | number } }): string {
  return String(typeof d.code === 'object' ? d.code.value : (d.code ?? ''));
}

export function withoutOverlap<D extends { code?: string | number | { value: string | number } }>(
  diagnostics: readonly D[],
): D[] {
  return diagnostics.filter((d) => !OVERLAPPING_RULES.has(codeOf(d)));
}

/**
 * Whether a file is inside a directory: the remote sources cache the server opens with Go to Definition, whose files
 * open read-only (`path.relative` compares Windows paths in any case, as VS Code writes drive letters in lower case).
 */
export function isInside(dir: string, path: string, rel: (from: string, to: string) => string): boolean {
  const r = rel(dir, path);
  return r !== '' && !r.startsWith('..') && !/^([a-z]:|[\\/])/i.test(r);
}
