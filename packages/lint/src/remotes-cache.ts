/**
 * The remote sources cache: the workflow files and `action.yml`s that `flowpact remotes update` and `remotes download`
 * fetch, kept per user by commit, so the editor can open them (go to definition). A file at a commit never changes, so
 * nothing in the cache goes stale, and any of it can be deleted at any time. The lockfile names the commit to open.
 * The cache itself is core's (`directoryRemoteCache`, at `<dir>/<host>/<owner>/<repo>/<sha>/<file>`); where it is, and
 * whether there is one in CI, is flowpact's.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  type DirectoryRemoteCache,
  pruneRemoteCache,
  type RemoteRef,
  remoteSourceFiles,
} from '@ciatlas/core';

/**
 * The cache's directory: `remotes` in `FLOWPACT_CACHE_DIR` (an absolute path), else in the platform's per-user cache:
 * `%LOCALAPPDATA%\flowpact\Cache` on Windows, `~/Library/Caches/flowpact` on macOS, `$XDG_CACHE_HOME/flowpact` (or
 * `~/.cache/flowpact`) elsewhere. Undefined when there is none: no absolute variable, and no home directory to start
 * from (`home` is looked up only then, and may fail).
 */
export function remotesCacheDir(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: () => string | undefined = homedir,
): string | undefined {
  const base = abs(env.FLOWPACT_CACHE_DIR) ?? platformCache(env, platform, home);
  return base && join(base, 'remotes');
}

/** The home directory, when there is one to find: `os.homedir` throws without HOME and a passwd entry. */
function homeOf(home: () => string | undefined): string | undefined {
  try {
    return abs(home());
  } catch {
    return undefined;
  }
}

/** An environment variable's path, when it is absolute; a relative one would depend on where flowpact runs. */
const abs = (v: string | undefined) => (v && isAbsolute(v) ? v : undefined);

/** flowpact's cache directory as the environment sets it: `FLOWPACT_CACHE_DIR`, when it is an absolute path. */
export const envCacheDir = (env: Record<string, string | undefined> = process.env) =>
  abs(env.FLOWPACT_CACHE_DIR);

/** The sources cache in a flowpact cache directory given as an option (`--cache-dir`), relative to where flowpact runs. */
export const remotesCacheIn = (cacheDir: string) => join(resolve(cacheDir), 'remotes');

/**
 * Whether flowpact runs in CI, where nobody opens the sources cache: `CI` is set (GitHub Actions, GitLab, CircleCI,
 * Bitbucket and most others set it), or Azure Pipelines' `TF_BUILD`, or Jenkins' `JENKINS_URL`.
 */
export function inCi(env: Record<string, string | undefined> = process.env): boolean {
  const ci = env.CI?.trim().toLowerCase();
  return (!!ci && ci !== 'false' && ci !== '0') || !!env.TF_BUILD || !!env.JENKINS_URL;
}

/**
 * The platform's per-user cache directory for flowpact; undefined when it would start from a home directory that is
 * missing or relative (an empty HOME), which would put the cache wherever flowpact runs.
 */
function platformCache(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  home: () => string | undefined,
): string | undefined {
  const inHome = (...parts: string[]) => {
    const h = homeOf(home);
    return h && join(h, ...parts);
  };
  if (platform === 'win32') {
    const local = abs(env.LOCALAPPDATA) ?? inHome('AppData', 'Local');
    return local && join(local, 'flowpact', 'Cache');
  }
  if (platform === 'darwin') return inHome('Library', 'Caches', 'flowpact');
  const cache = abs(env.XDG_CACHE_HOME) ?? inHome('.cache');
  return cache && join(cache, 'flowpact');
}

/** A remote reference's cached file at a commit on a host, when the cache has it: its path on disk and in the repository. */
export function cachedSource(
  cache: Pick<DirectoryRemoteCache, 'locate'>,
  host: string,
  r: Pick<RemoteRef, 'kind' | 'owner' | 'repo' | 'path'>,
  sha: string,
): { path: string; file: string } | undefined {
  for (const file of remoteSourceFiles(r)) {
    const path = cache.locate({ host, owner: r.owner, repo: r.repo, sha, file });
    if (path) return { path, file };
  }
  return undefined;
}

/** How many commits of each repository the cache keeps after `remotes update` and `remotes download`. */
export const KEEP_COMMITS = 3;

/** A repository's commit in the cache, as `owner/repo/sha` in lower case: what a prune must keep, on any host. */
export const commitKey = (r: Pick<RemoteRef, 'owner' | 'repo'>, sha: string) =>
  `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}/${sha.toLowerCase()}`;

/**
 * Keeps the `KEEP_COMMITS` most recently used commits of each repository in the cache and every commit in `used`
 * (`commitKey`), and removes the others (see core's `pruneRemoteCache`). Never throws.
 */
export const pruneUsed = (dir: string, used: ReadonlySet<string>) =>
  pruneRemoteCache(dir, { keepCommits: KEEP_COMMITS, keep: (c) => used.has(commitKey(c, c.sha)) });
