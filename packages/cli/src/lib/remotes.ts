/** `remotes update`: the remote interfaces lockfile, fetched and written (or previewed). */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Logger, nodeFileSystem } from '@ciatlas/core';
import {
  assertSafeWritePath,
  type FetchProgress,
  REMOTES_LOCK_FILES,
  type RemotesUpdate,
  readRemotesLock,
  serializeRemotesLock,
  updateRemotesLock,
} from '@flowpact/lint';
import { attempt, usage } from './errors';
import { analyzeSession, bool, type Session, stringList } from './session';
import { checkTargets, protectedTrees } from './targets';

export interface RemotesUpdateOptions {
  /**
   * Workflow and action files or directories, relative to the root: fetch only the remote references they, and the
   * local workflows and actions they reach, use. Other entries are kept. Default: all.
   */
  paths?: string[];
  /** Compute the lockfile without writing it. */
  dryRun?: boolean;
  /** The token to read the remote repositories with; by default `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`. */
  token?: string;
  /** The GitHub API; by default `GITHUB_API_URL` or `https://api.github.com`. */
  apiUrl?: string;
  /** Called as each reference is fetched (or not), after its debug log line; for a progress display. */
  onProgress?: (p: FetchProgress) => void;
}

/** A debug log line per reference as it is done, then `then`, if given. */
export function logProgress(logger: Logger, then?: (p: FetchProgress) => void): (p: FetchProgress) => void {
  return (p) => {
    const what = p.outcome === 'fetched' ? `at ${p.detail.slice(0, 7)}` : `${p.outcome}: ${p.detail}`;
    logger.debug(`remote interface ${p.done}/${p.total}: ${p.ref} ${what}`);
    then?.(p);
  };
}

export interface RemotesUpdateResult extends Omit<RemotesUpdate, 'lock'> {
  /** The lockfile, relative to the root. */
  file: string;
  /** Whether its text changes. */
  changes: boolean;
  dryRun: boolean;
  /** Where the token came from (`GH_TOKEN`, `GITHUB_TOKEN`, `gh auth token`, the option), or undefined without one. */
  tokenSource?: string;
}

/** The GitHub API: `GITHUB_API_URL` (GitHub Enterprise Server), else github.com's. */
export const apiUrlFromEnv = () => process.env.GITHUB_API_URL || 'https://api.github.com';

/** The GitHub CLI's token, when it is installed and signed in; never printed. */
function ghToken(): string | undefined {
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/** The token to read remote repositories with: the option, `GH_TOKEN`, `GITHUB_TOKEN`, or github.com's `gh` token. */
export function tokenFor(apiUrl: string, given: string | undefined): { token?: string; source?: string } {
  if (given) return { token: given, source: 'the token option' };
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN'] as const)
    if (process.env[name]) return { token: process.env[name], source: name };
  const gh = apiUrl === 'https://api.github.com' ? ghToken() : undefined;
  return gh ? { token: gh, source: '`gh auth token`' } : {};
}

/** Where the token for remote interfaces comes from, for a log line; the token itself is never shown. */
export const describeToken = (source: string | undefined) =>
  source ?? 'none: public repositories only, at 60 requests an hour';

/** Runs the fetching and logs how long it took once it is done (`Logger.time` does not wait for a promise). */
export async function timed<T>(logger: Logger, run: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const out = await run();
  logger.debug('fetch remote interfaces finished', { ms: Math.round(performance.now() - t0) });
  return out;
}

/** How to fetch: the API, the token (and, for the output, where it came from), and the progress to report. */
function fetchOptions(logger: Logger, options: RemotesUpdateOptions) {
  const apiUrl = options.apiUrl ?? apiUrlFromEnv();
  const { token, source } = tokenFor(apiUrl, options.token);
  logger.debug(`remote interfaces: token from ${describeToken(source)}`);
  return {
    source,
    fetch: { apiUrl, ...(token ? { token } : {}), onProgress: logProgress(logger, options.onProgress) },
  };
}

/** Writes the lockfile, refusing a path that leaves the repository through a link. */
function writeLock(root: string, file: string, text: string): void {
  const abs = join(root, file);
  attempt(() => assertSafeWritePath(abs, protectedTrees(root)));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

export async function runRemotesUpdate(
  session: Session,
  options: RemotesUpdateOptions = {},
): Promise<RemotesUpdateResult> {
  if (options.token !== undefined && typeof options.token !== 'string') throw usage('token must be a string');
  const { root, logger } = session;
  const paths = stringList('paths', options.paths) ?? [];
  const result = await analyzeSession(session, { paths, only: [], validateSchema: false });
  checkTargets(result.project, paths, root);
  const fs = nodeFileSystem(root);
  const read = readRemotesLock(fs);
  const file = read.file ?? REMOTES_LOCK_FILES[0];
  const { fetch, source } = fetchOptions(logger, options);
  const update = await timed(logger, () => updateRemotesLock(result.index, read.lock, fetch));
  const text = serializeRemotesLock(update.lock);
  const dryRun = bool('dryRun', options.dryRun) ?? false;
  const changes = fs.read(file) !== text;
  if (changes && !dryRun) writeLock(root, file, text);
  const { lock: _, ...rest } = update;
  return { ...rest, file, changes, dryRun, ...(source ? { tokenSource: source } : {}) };
}
