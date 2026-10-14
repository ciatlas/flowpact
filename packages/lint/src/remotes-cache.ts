/**
 * The remote sources cache: the workflow files and `action.yml`s that `flowpact remotes update` and `remotes download`
 * fetch, kept per user by commit, so the editor can open them (go to definition). A file at a commit never changes, so
 * nothing in the cache goes stale, and any of it can be deleted at any time. The lockfile names the commit to open.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { RemoteRef } from './remotes';

/**
 * The cache's directory: `remotes` in `FLOWPACT_CACHE_DIR` (an absolute path), else in the platform's per-user cache:
 * `%LOCALAPPDATA%\flowpact\Cache` on Windows, `~/Library/Caches/flowpact` on macOS, `$XDG_CACHE_HOME/flowpact` (or
 * `~/.cache/flowpact`) elsewhere.
 */
export function remotesCacheDir(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return join(abs(env.FLOWPACT_CACHE_DIR) ?? platformCache(env, platform, home), 'remotes');
}

/** An environment variable's path, when it is absolute; a relative one would depend on where flowpact runs. */
const abs = (v: string | undefined) => (v && isAbsolute(v) ? v : undefined);

/** The platform's per-user cache directory for flowpact. */
function platformCache(env: Record<string, string | undefined>, platform: NodeJS.Platform, home: string) {
  if (platform === 'win32')
    return join(abs(env.LOCALAPPDATA) ?? join(home, 'AppData', 'Local'), 'flowpact', 'Cache');
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'flowpact');
  return join(abs(env.XDG_CACHE_HOME) ?? join(home, '.cache'), 'flowpact');
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
 * Keeps a fetched file in the cache unless it is there: written read-only to a temporary file, then renamed, so a
 * reader never sees half a file. Never throws: the cache only helps the editor.
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
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, text, { mode: 0o444, flag: 'wx' });
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
