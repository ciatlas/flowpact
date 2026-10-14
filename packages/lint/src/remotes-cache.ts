/**
 * The remote sources cache: the workflow files and `action.yml`s that `flowpact remotes update` and `remotes download`
 * fetch, kept per user by commit, so the editor can open them (go to definition). A file at a commit never changes, so
 * nothing in the cache goes stale, and any of it can be deleted at any time. The lockfile names the commit to open.
 */
import { randomBytes } from 'node:crypto';
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { RemoteRef } from './remotes';

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

/** Names Windows reserves for devices, with any extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Whether a part of a path is a file name on every platform: not empty, `.` or `..`, without a separator, a drive's
 * colon, another character Windows rejects or a control character, not ending in a dot or a space, and no device name.
 */
function safeName(s: string): boolean {
  if (s === '' || s === '.' || s === '..' || /[<>:"/\\|?*]/.test(s) || /[. ]$/.test(s)) return false;
  if (WINDOWS_RESERVED.test(s)) return false;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32) return false;
  return true;
}

/**
 * Where a file of a remote repository at a commit is kept: `<dir>/<owner>/<repo>/<sha>/<file>`, the owner and repository
 * in lower case (GitHub matches them in any case). Undefined when a part could not be a file name safely (`..`, a
 * drive, a character Windows rejects): such a file is not cached.
 */
export function cachedSourcePath(
  dir: string,
  r: Pick<RemoteRef, 'owner' | 'repo'>,
  sha: string,
  file: string,
): string | undefined {
  if (!/^[0-9a-f]{40}$/.test(sha)) return undefined;
  const parts = [r.owner.toLowerCase(), r.repo.toLowerCase(), sha, ...file.split('/')];
  if (!parts.every(safeName)) return undefined;
  const path = join(dir, ...parts);
  const rel = relative(dir, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? path : undefined;
}

/** The files a remote reference's interface is read from: its workflow file, or its action's `action.yml` or `.yaml`. */
export const sourceFiles = (r: Pick<RemoteRef, 'kind' | 'path'>): string[] =>
  r.kind === 'workflow'
    ? [r.path]
    : ['action.yml', 'action.yaml'].map((n) => (r.path ? `${r.path}/${n}` : n));

/** The cached file of a remote reference at a commit, when the cache has it: its path on disk, and in the repository. */
export function cachedSource(
  dir: string,
  r: Pick<RemoteRef, 'kind' | 'owner' | 'repo' | 'path'>,
  sha: string,
): { path: string; file: string } | undefined {
  for (const file of sourceFiles(r)) {
    const path = cachedSourcePath(dir, r, sha, file);
    if (path && existsSync(path)) return { path, file };
  }
  return undefined;
}

/** What became of a file given to the cache: written, there already, not cachable (an unsafe path), or why not. */
export type CacheOutcome = 'written' | 'present' | 'unsafe' | { failed: string };

/**
 * Keeps a fetched file in the cache unless it is there: written read-only, for your user alone, to a temporary file,
 * then renamed, so a reader never sees half a file. Never throws: the cache only helps the editor.
 */
export function cacheSource(
  dir: string,
  r: Pick<RemoteRef, 'owner' | 'repo'>,
  sha: string,
  file: string,
  text: string,
): CacheOutcome {
  const path = cachedSourcePath(dir, r, sha, file);
  if (!path) return 'unsafe';
  if (existsSync(path)) return 'present';
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    // The text is a file another repository serves (CodeQL's "network data written to a file"), kept on purpose: never
    // run, at most 1 MB (the fetcher refuses more), under a path whose every part was checked above, read-only and not
    // executable. For your user alone: the files of private repositories land here too, wherever the cache is.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, text, { mode: 0o400, flag: 'wx' });
    renameSync(tmp, path);
    return 'written';
  } catch (e) {
    removeQuietly(tmp);
    // Another run wrote it first (Windows refuses the rename then); a file at a commit is the same file.
    return existsSync(path) ? 'present' : { failed: (e as Error).message };
  }
}

/** Removes a file if it is there; when its directory is not even one, there is nothing to remove. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // ENOTDIR and the like: the temporary file was never written.
  }
}

/** How many commits of each repository the cache keeps after `remotes update` and `remotes download`. */
export const KEEP_COMMITS = 3;

/** A repository's commit in the cache, as `owner/repo/sha` in lower case: what a prune must keep. */
export const commitKey = (r: Pick<RemoteRef, 'owner' | 'repo'>, sha: string) =>
  `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}/${sha}`;

/**
 * Marks a cached commit as just used, so pruning keeps the most recently used ones (the time of its directory). Never
 * throws: the cache only helps the editor.
 */
export function touchCommit(dir: string, r: Pick<RemoteRef, 'owner' | 'repo'>, sha: string): void {
  const path = commitDir(dir, r, sha);
  if (!path) return;
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch {
    // Not cached (any more): nothing to mark.
  }
}

/** A repository's commit directory in the cache; undefined when a part could not be a file name safely. */
function commitDir(dir: string, r: Pick<RemoteRef, 'owner' | 'repo'>, sha: string): string | undefined {
  const parts = [r.owner.toLowerCase(), r.repo.toLowerCase(), sha];
  return /^[0-9a-f]{40}$/.test(sha) && parts.every(safeName) ? join(dir, ...parts) : undefined;
}

export interface PruneOptions {
  /** The repositories to prune (`owner/repo`, any case); every repository in the cache without it. */
  repos?: Iterable<string>;
  /** Commits never removed (`commitKey`): those the run that prunes uses. */
  keep?: Set<string>;
}

/**
 * Keeps the `keep` most recently used commits of each repository in the cache and removes the others: only directories
 * named by a commit, at `<owner>/<repo>/<sha>`, never a link or anything else a user put there, then the repository and
 * owner directories left empty. Returns how many commits it removed, and why one could not be. Never throws.
 */
export function pruneCache(
  dir: string,
  keep: number,
  opts: PruneOptions = {},
): { removed: number; failed?: string } {
  const out: { removed: number; failed?: string } = { removed: 0 };
  const repos = opts.repos
    ? [...new Set([...opts.repos].map((r) => r.toLowerCase()))].map((r) => r.split('/') as [string, string])
    : allRepos(dir);
  for (const [owner, repo] of repos) {
    if (!safeName(owner) || !safeName(repo)) continue;
    const commits = commitsOf(join(dir, owner, repo));
    commits.sort((a, b) => b.time - a.time);
    for (const c of commits.slice(keep)) {
      if (opts.keep?.has(`${owner}/${repo}/${c.sha}`)) continue;
      try {
        rmSync(c.path, { recursive: true, force: true });
        out.removed++;
      } catch (e) {
        out.failed ??= (e as Error).message;
      }
    }
    removeIfEmpty(join(dir, owner, repo));
    removeIfEmpty(join(dir, owner));
  }
  return out;
}

/** The directories of a directory, without following links; none when it cannot be read. */
function subdirs(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
}

/** Every `owner/repo` in the cache. */
const allRepos = (dir: string): [string, string][] =>
  subdirs(dir).flatMap((o) => subdirs(join(dir, o.name)).map((r): [string, string] => [o.name, r.name]));

/** A repository's cached commits, with when each was last used. */
function commitsOf(path: string): { sha: string; path: string; time: number }[] {
  return subdirs(path)
    .filter((d) => /^[0-9a-f]{40}$/.test(d.name))
    .flatMap((d) => {
      const p = join(path, d.name);
      try {
        return [{ sha: d.name, path: p, time: statSync(p).mtimeMs }];
      } catch {
        return [];
      }
    });
}

/** Removes a directory when it is empty, and leaves it otherwise. */
function removeIfEmpty(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // Not empty, or gone: either way there is nothing to do.
  }
}
