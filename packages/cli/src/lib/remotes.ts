/**
 * `remotes update`: the remote interfaces lockfile, fetched and written (or previewed), and the files read kept in the
 * sources cache; `remotes download`: the sources of the locked commits, into the cache.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { escapeControl, type Logger, nodeFileSystem } from '@ciatlas/core';
import {
  assertSafeWritePath,
  cacheSource,
  downloadRemoteSources,
  envCacheDir,
  type FetchedSource,
  type FetchProgress,
  hostOf,
  inCi,
  REMOTES_LOCK_FILES,
  type RemotesDownload,
  type RemotesLock,
  type RemotesUpdate,
  readRemotesLock,
  remotesCacheDir,
  remotesCacheIn,
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
  /**
   * On a GitHub Enterprise Server or GHE.com, also look for the references it lacks on github.com, as GitHub Connect
   * does (`--github-com`). Opt-in: it sends their names to github.com.
   */
  githubCom?: boolean;
  /** Called as each reference is fetched (or not), after its debug log line; for a progress display. */
  onProgress?: (p: FetchProgress) => void;
  /**
   * flowpact's cache directory, whose `remotes` directory keeps the files read for the editor (`--cache-dir`, relative to
   * where flowpact runs); `false` keeps none. By default `FLOWPACT_CACHE_DIR`, else none in CI, else the platform's
   * per-user cache (see `remotesCacheDir`). Nothing is kept with `dryRun`.
   */
  cacheDir?: string | false;
}

/** A debug log line per reference as it is done (`what`: a remote interface, or source), then `then`, if given. */
function logProgress(
  logger: Logger,
  then?: (p: FetchProgress) => void,
  what = 'remote interface',
): (p: FetchProgress) => void {
  return (p) => {
    const how =
      p.outcome === 'fetched' || p.outcome === 'cached'
        ? `${p.outcome === 'cached' ? 'cached ' : ''}at ${p.detail.slice(0, 7)}`
        : `${p.outcome}: ${p.detail}`;
    logger.debug(`${what} ${p.done}/${p.total}: ${escapeControl(p.ref)} ${escapeControl(how)}`);
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
  /** The sources cache, unless none was kept: how many files were written to it, and why one could not be. */
  sources?: SourcesKept;
  /** Why no file was kept, when that was not asked for: in CI. */
  sourcesNotKept?: string;
}

export interface SourcesKept {
  dir: string;
  written: number;
  /** How many files could not be written, and why the first one could not; the lockfile is written all the same. */
  notKept: number;
  failed?: string;
}

/** The GitHub API: `GITHUB_API_URL` (GitHub Enterprise Server), else github.com's. */
const apiUrlFromEnv = () => process.env.GITHUB_API_URL || 'https://api.github.com';

/** The GitHub CLI's token, when it is installed and signed in; never printed. */
function ghToken(host: string): string | undefined {
  const r = spawnSync('gh', ['auth', 'token', '--hostname', host], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/**
 * The token to read remote repositories with: the option, `GH_TOKEN`, `GITHUB_TOKEN`, or the GitHub CLI's for the
 * API's host (`gh auth token --hostname`, so a GitHub Enterprise Server sign-in works too).
 */
function tokenFor(apiUrl: string, given: string | undefined): { token?: string; source?: string } {
  if (given) return { token: given, source: 'the token option' };
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN'] as const)
    if (process.env[name]) return { token: process.env[name], source: name };
  const host = hostOf(apiUrl);
  const gh = ghToken(host);
  return gh ? { token: gh, source: `\`gh auth token --hostname ${host}\`` } : {};
}

const GITHUB_COM_API = 'https://api.github.com';

/**
 * With `githubCom`, on a GitHub Enterprise Server or GHE.com: look for the references the API lacks on github.com, as
 * the runner does through GitHub Connect, with `GITHUB_COM_TOKEN` or none (never the enterprise token).
 */
function githubComFallback(apiUrl: string, githubCom: boolean | undefined, logger: Logger) {
  if (!githubCom || hostOf(apiUrl) === 'github.com') return {};
  const token = process.env.GITHUB_COM_TOKEN;
  logger.debug(
    `remote interfaces: also looking on github.com, with ${token ? 'GITHUB_COM_TOKEN' : 'no token'}`,
  );
  return { fallback: { apiUrl: GITHUB_COM_API, ...(token ? { token } : {}) } };
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
export function fetchOptions(
  logger: Logger,
  options: Pick<RemotesUpdateOptions, 'apiUrl' | 'token' | 'githubCom' | 'onProgress'>,
  what?: string,
) {
  const apiUrl = options.apiUrl ?? apiUrlFromEnv();
  const { token, source } = tokenFor(apiUrl, options.token);
  logger.debug(`remote interfaces: ${apiUrl}, token from ${describeToken(source)}`);
  return {
    source,
    fetch: {
      apiUrl,
      ...(token ? { token } : {}),
      ...githubComFallback(apiUrl, options.githubCom, logger),
      onProgress: logProgress(logger, options.onProgress, what),
    },
  };
}

/** Writes the lockfile, refusing a path that leaves the repository through a link. */
function writeLock(root: string, file: string, text: string): void {
  const abs = join(root, file);
  attempt(() => assertSafeWritePath(abs, protectedTrees(root)));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

/** The analysis `remotes` works on: the repository, or what the given paths reach; a bad option or path is refused. */
async function analyzeTargets(session: Session, options: Pick<RemotesUpdateOptions, 'paths' | 'token'>) {
  if (options.token !== undefined && typeof options.token !== 'string') throw usage('token must be a string');
  const paths = stringList('paths', options.paths) ?? [];
  const result = await analyzeSession(session, { paths, only: [], validateSchema: false });
  checkTargets(result.project, paths, session.root);
  return result;
}

export async function runRemotesUpdate(
  session: Session,
  options: RemotesUpdateOptions = {},
): Promise<RemotesUpdateResult> {
  const { root, logger } = session;
  const result = await analyzeTargets(session, options);
  const fs = nodeFileSystem(root);
  const read = readRemotesLock(fs);
  const file = read.file ?? REMOTES_LOCK_FILES[0];
  const { fetch, source } = fetchOptions(logger, options);
  const dryRun = bool('dryRun', options.dryRun) ?? false;
  const keep = sourcesKeeper(dryRun ? {} : updateCacheDir(options.cacheDir), logger);
  const update = await timed(logger, () =>
    updateRemotesLock(result.index, read.lock, { ...fetch, ...keep.fetch }),
  );
  const text = serializeRemotesLock(update.lock);
  const changes = fs.read(file) !== text;
  if (changes && !dryRun) writeLock(root, file, text);
  const { lock: _, ...rest } = update;
  const extra = { ...(source ? { tokenSource: source } : {}), ...keep.result };
  return { ...rest, file, changes, dryRun, ...extra };
}

/** The sources cache in the `cacheDir` option, refusing anything but a directory's path. */
function cacheDirIn(option: unknown): string {
  if (typeof option !== 'string' || option.trim() === '') throw usage('cacheDir must be a directory');
  return remotesCacheIn(option);
}

/**
 * Where `remotes update` keeps the files it reads: the `cacheDir` option, else `FLOWPACT_CACHE_DIR`, else the platform's
 * per-user cache, but nowhere in CI (or for `false`), with why when nobody asked for that.
 */
function updateCacheDir(option: string | false | undefined): { dir?: string; why?: string } {
  if (option === false) return {};
  if (option !== undefined) return { dir: cacheDirIn(option) };
  if (!envCacheDir() && inCi()) return { why: 'not kept in CI (CI is set): --cache-dir keeps them' };
  const dir = remotesCacheDir();
  return dir ? { dir } : { why: `not kept: ${NO_CACHE_DIR}` };
}

/** Why there is no default cache directory, and how to give one. */
const NO_CACHE_DIR =
  'no home directory to keep a per-user cache in: --cache-dir or FLOWPACT_CACHE_DIR gives one';

/**
 * Keeps each fetched file in the sources cache, when there is one, counting what it wrote (a failure is logged, never
 * thrown): the option to fetch with, and the result's fields to report it.
 */
function sourcesKeeper(
  cache: { dir?: string; why?: string },
  logger: Logger,
): { fetch: { onSource?: (s: FetchedSource) => void }; result: Partial<RemotesUpdateResult> } {
  if (!cache.dir) return { fetch: {}, result: cache.why ? { sourcesNotKept: cache.why } : {} };
  const dir = cache.dir;
  const kept: SourcesKept = { dir, written: 0, notKept: 0 };
  const onSource = (s: FetchedSource) => {
    const outcome = cacheSource(dir, s.ref, s.sha, s.file, s.text);
    if (outcome === 'written') kept.written++;
    else if (outcome === 'unsafe')
      logger.debug(`source not cached: ${escapeControl(s.ref.raw)}: its path cannot be a file name`);
    else if (typeof outcome === 'object') {
      logger.debug(`source not cached: ${escapeControl(s.ref.raw)}: ${outcome.failed}`);
      kept.notKept++;
      kept.failed ??= outcome.failed;
    }
  };
  return { fetch: { onSource }, result: { sources: kept } };
}

export interface RemotesDownloadOptions
  extends Pick<RemotesUpdateOptions, 'paths' | 'token' | 'apiUrl' | 'githubCom' | 'onProgress'> {
  /**
   * flowpact's cache directory, whose `remotes` directory the sources go to (`--cache-dir`, relative to where flowpact
   * runs); by default `FLOWPACT_CACHE_DIR`, else the platform's per-user cache, also in CI: downloading is all it does.
   */
  cacheDir?: string;
}

export interface RemotesDownloadResult extends RemotesDownload {
  /** The lockfile, relative to the root, and the sources cache's directory. */
  file: string;
  dir: string;
  tokenSource?: string;
}

/**
 * `remotes download`: the sources of the remote references the repository uses (or the given paths), at the commits the
 * lockfile pins, into the sources cache. The lockfile is required and does not change.
 */
export async function runRemotesDownload(
  session: Session,
  options: RemotesDownloadOptions = {},
): Promise<RemotesDownloadResult> {
  const { root, logger } = session;
  const dir = options.cacheDir !== undefined ? cacheDirIn(options.cacheDir) : remotesCacheDir();
  if (!dir) throw usage(`nowhere to download to: ${NO_CACHE_DIR}`);
  const { file, lock } = requireLock(root);
  const result = await analyzeTargets(session, options);
  const { fetch, source } = fetchOptions(logger, options, 'remote source');
  logger.debug(`remote sources: ${dir}`);
  const download = await timed(logger, () => downloadRemoteSources(result.index, lock, dir, fetch));
  return { ...download, file, dir, ...(source ? { tokenSource: source } : {}) };
}

/** The lockfile, which `remotes download` needs: none, or one it cannot use, is a usage error. */
function requireLock(root: string): { file: string; lock: RemotesLock } {
  const read = readRemotesLock(nodeFileSystem(root));
  if (!read.file)
    throw usage(`no remotes lockfile: run \`flowpact remotes update\` to write ${REMOTES_LOCK_FILES[0]}`);
  if (!read.lock) throw usage(`${read.file} cannot be used: ${read.error}`);
  return { file: read.file, lock: read.lock };
}
