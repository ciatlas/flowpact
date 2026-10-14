/** `remotes update`: the remote interfaces lockfile, fetched and written (or previewed). */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nodeFileSystem } from '@ciatlas/core';
import {
  assertSafeWritePath,
  REMOTES_LOCK_FILES,
  type RemotesUpdate,
  readRemotesLock,
  serializeRemotesLock,
  updateRemotesLock,
} from '@flowpact/lint';
import { attempt, usage } from './errors';
import { analyzeSession, bool, type Session } from './session';
import { protectedTrees } from './targets';

export interface RemotesUpdateOptions {
  /** Compute the lockfile without writing it. */
  dryRun?: boolean;
  /** The token to read the remote repositories with; by default `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`. */
  token?: string;
  /** The GitHub API; by default `GITHUB_API_URL` or `https://api.github.com`. */
  apiUrl?: string;
}

export interface RemotesUpdateResult extends Omit<RemotesUpdate, 'lock'> {
  /** The lockfile, relative to the root. */
  file: string;
  /** Whether its text changes. */
  changes: boolean;
  dryRun: boolean;
  /** Whether a token was used. */
  authenticated: boolean;
}

/** The GitHub API: `GITHUB_API_URL` (GitHub Enterprise Server), else github.com's. */
export const apiUrlFromEnv = () => process.env.GITHUB_API_URL || 'https://api.github.com';

/** The GitHub CLI's token, when it is installed and signed in; never printed. */
function ghToken(): string | undefined {
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/** The token to read remote repositories with: the option, `GH_TOKEN`, `GITHUB_TOKEN`, or github.com's `gh` token. */
export function tokenFor(apiUrl: string, given: string | undefined): string | undefined {
  if (given) return given;
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  return apiUrl === 'https://api.github.com' ? ghToken() : undefined;
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
  const result = await analyzeSession(session, { only: [], validateSchema: false });
  const fs = nodeFileSystem(root);
  const read = readRemotesLock(fs);
  const file = read.file ?? REMOTES_LOCK_FILES[0];
  const apiUrl = options.apiUrl ?? apiUrlFromEnv();
  const token = tokenFor(apiUrl, options.token);
  const update = await logger.time('fetch remote interfaces', () =>
    updateRemotesLock(result.index, read.lock, { apiUrl, ...(token ? { token } : {}) }),
  );
  const text = serializeRemotesLock(update.lock);
  const dryRun = bool('dryRun', options.dryRun) ?? false;
  const changes = fs.read(file) !== text;
  if (changes && !dryRun) writeLock(root, file, text);
  const { lock: _, ...rest } = update;
  return { ...rest, file, changes, dryRun, authenticated: Boolean(token) };
}
